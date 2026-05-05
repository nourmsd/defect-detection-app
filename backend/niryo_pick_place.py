"""
niryo_pick_place.py — Niryo Pick & Place Controller
=====================================================
Hardware configuration:
  Robot Software Version : 4.1.0
  Niryo Studio           : 4.1.2
  Stepper firmware:
    joint_1: 1.0.30   joint_2: 1.0.30   joint_3: 1.0.30
    joint_4: 46       joint_5: 46       joint_6: 49
  End Effector : 1.0.10
  Tool         : 46  (Large Gripper)

Pick & Place Workflow (DEFECTIVE items only):
  ┌─────────────────────────────────────────────────────┐
  │  HOME → READING (await AI result)                   │
  │  If DEFECTIVE:                                      │
  │    READING → [pick] → PATH_POINT → ABOVE_BIN        │
  │    ABOVE_BIN → [release] → PATH_POINT → READING      │
  │  If OK:                                             │
  │    Stay at READING — item passes on conveyor         │
  └─────────────────────────────────────────────────────┘

HOW TO USE:
  1. Set ROBOT_IP to your robot's IP (default Niryo IP: 10.10.10.10).
  2. In Niryo Studio, jog the robot to each position and read joint values
     from the Joints panel (in radians). Paste them into the constants below.
  3. Run:  python niryo_pick_place.py
  4. The script exposes a small HTTP server on port 5002.
     The Node.js backend will POST inspection results to it automatically.
"""

import time
import logging
import threading
import queue as queue_module
import urllib.request
from flask import Flask, request, jsonify
from flask_cors import CORS

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CONFIGURATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ROBOT_IP             = "10.10.10.10"   # Niryo default hotspot IP
ROBOT_SERVICE_PORT   = 5002            # this script's HTTP port
BACKEND_URL          = "http://127.0.0.1:5000"  # Node.js backend
STREAM_SERVICE_URL   = "http://127.0.0.1:5001"

CONNECT_TIMEOUT_S    = 10   # seconds to wait for robot TCP connection
MOVE_SPEED           = 25   # joint speed percentage (1-100), keep low for safety
GRIPPER_SPEED        = 400  # gripper open/close speed (0-1000)
GRIPPER_HOLD_MS      = 600  # ms to hold after grasp before moving
GRIPPER_RELEASE_MS   = 400  # ms to hold after release before next move
POLL_INTERVAL_S      = 0.5  # how often the worker checks the action queue

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# JOINT POSITIONS  (radians)
#
# ┌────────────────────────────────────────────────────────────────────┐
# │  HOW TO FILL THESE IN:                                             │
# │  1. Open Niryo Studio → Connect to robot                          │
# │  2. Enable "Manual mode" or use the jog panel                     │
# │  3. Move arm to each position using the Joints sliders            │
# │  4. Copy the 6 joint values (j1…j6) shown in the Joints panel    │
# │  5. Replace the 0.0 placeholders below (values are in radians)    │
# └────────────────────────────────────────────────────────────────────┘

# ── 1. HOME ─────────────────────────────────────────────────────────
#  Safe rest position — robot folds away from the conveyor
HOME_JOINTS = [
    0.09,    # joint_1  ← TODO set manually
    0.61,    # joint_2  ← TODO set manually
   -1.34,   # joint_3  ← TODO set manually
    0.09,    # joint_4  ← TODO set manually
   -0.08,    # joint_5  ← TODO set manually
    0.08,    # joint_6  ← TODO set manually
]

# ── 2. READING ───────────────────────────────────────────────────────
#  Gripper positioned ON the product sitting on the conveyor inspection
#  zone — robot is ready to either pick (defective) or release (OK)
READING_JOINTS = [
    0.20,    # joint_1  ← TODO set manually
    -0.42,    # joint_2  ← TODO set manually
    -0.73,    # joint_3  ← TODO set manually
    0.16,    # joint_4  ← TODO set manually
    -0.50,    # joint_5  ← TODO set manually
    0.19,    # joint_6  ← TODO set manually
]

# ── 3. PATH_POINT ────────────────────────────────────────────────────
#  Intermediate clearance waypoint between reading zone and reject bin.
#  Must be high enough to clear the conveyor frame and any obstacles.
#  The robot passes through this point in BOTH directions.
PATH_JOINTS = [
    1.12,    # joint_1  ← TODO set manually
    0.03,    # joint_2  ← TODO set manually
    -0.75,    # joint_3  ← TODO set manually
    -0.14,    # joint_4  ← TODO set manually
    -0.29,    # joint_5  ← TODO set manually
    0.19,    # joint_6  ← TODO set manually
]

# ── 4. ABOVE_BIN ─────────────────────────────────────────────────────
#  Directly above the reject bin, gripper pointing downward.
#  Robot will release (open gripper) while in this position.
ABOVE_BIN_JOINTS = [
    1.74,    # joint_1  ← TODO set manually
    -0.52,    # joint_2  ← TODO set manually
    -0.06,    # joint_3  ← TODO set manually
    -0.13,    # joint_4  ← TODO set manually
    -0.74,    # joint_5  ← TODO set manually
    0.19,    # joint_6  ← TODO set manually
]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LOGGING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("niryo-pick-place")
logging.getLogger("werkzeug").setLevel(logging.ERROR)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SHARED STATE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_state_lock        = threading.Lock()
_robot             = None          # pyniryo2 NiryoRobot instance
_robot_ok          = False         # True once connected and calibrated
_robot_busy        = False         # True while executing a pick-place cycle
_last_action       = "idle"        # last executed action string
_action_queue      = queue_module.Queue(maxsize=20)
_freemotion_active = False         # True when arm is in learning/free mode
_recovery_in_progress = False      # True while a reconnect/calibration is running
_robot_session_mode = "standby"    # standby | connecting | active


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ROBOT CONNECTION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def ensure_robot_ready():
    """
    Best-effort self-heal:
    if robot is not ready, try reconnect + startup calibration sequence once.
    """
    global _recovery_in_progress
    with _state_lock:
        if _robot_ok and _robot is not None:
            return True
        if _recovery_in_progress:
            wait_for_existing_recovery = True
        else:
            _recovery_in_progress = True
            wait_for_existing_recovery = False

    if wait_for_existing_recovery:
        # Another request is already reconnecting/calibrating; wait for it.
        deadline = time.time() + CONNECT_TIMEOUT_S + 20
        while time.time() < deadline:
            with _state_lock:
                if _robot_ok and _robot is not None:
                    return True
                if not _recovery_in_progress:
                    break
            time.sleep(0.25)
        with _state_lock:
            return _robot_ok and _robot is not None

    try:
        log.warning("Robot not ready — attempting automatic recovery")
        connect_robot()
    except Exception as exc:
        log.error(f"Automatic recovery failed: {exc}")
    finally:
        with _state_lock:
            _recovery_in_progress = False

    with _state_lock:
        return _robot_ok and _robot is not None

def connect_robot():
    """Connect to Niryo robot via pyniryo2 and update shared state."""
    global _robot, _robot_ok, _robot_session_mode

    try:
        with _state_lock:
            _robot_session_mode = "connecting"
        _set_stream_camera_paused(True)
        from pyniryo import NiryoRobot
        log.info(f"Connecting to Niryo robot at {ROBOT_IP} …")
        robot = NiryoRobot(ROBOT_IP)
        log.info("Robot TCP connected ✔")

        arm = getattr(robot, "arm", robot)  # SDK compatibility (some versions expose arm.*)

        log.info("Calibrating …")
        _call_first_available(arm, ["calibrate_auto", "calibrate"])
        log.info("Calibration done ✔")

        _call_first_available(arm, ["set_arm_max_velocity", "set_max_velocity"], MOVE_SPEED)

        tool = getattr(robot, "tool", None)
        if tool is not None:
            try:
                _call_first_available(tool, ["update_tool", "refresh_tool"])
                log.info(f"Tool detected: {getattr(tool, 'tool', 'unknown')}")
            except Exception as tool_exc:
                log.warning(f"Tool init warning: {tool_exc}")

        with _state_lock:
            _robot   = robot
            _robot_ok = True
            _robot_session_mode = "active"

        log.info("Startup sequence: auto-calibrated, moving to HOME position …")
        safe_move(HOME_JOINTS, label="HOME")
        log.info("Moving from HOME to READING position …")
        safe_move(READING_JOINTS, label="READING")
        close_gripper()
        log.info("Gripper set to CLOSED at startup")
        log.info("Robot ready at READING position")

    except Exception as exc:
        log.error(f"Robot connection failed: {exc}")
        with _state_lock:
            _robot    = None
            _robot_ok = False
            _robot_session_mode = "standby"
        _set_stream_camera_paused(False)
        raise


def release_robot_connection(reason="standby"):
    """Release the exclusive Niryo TCP client so the stream can reconnect."""
    global _robot, _robot_ok, _freemotion_active, _robot_session_mode

    with _state_lock:
        robot = _robot
        _robot = None
        _robot_ok = False
        _freemotion_active = False
        _robot_session_mode = "standby"

    if robot is not None:
        try:
            close_fn = getattr(robot, "close_connection", None)
            if callable(close_fn):
                close_fn()
                log.info(f"Released robot connection â€” {reason}")
        except Exception as exc:
            log.warning(f"Robot disconnect warning: {exc}")

    _set_stream_camera_paused(False)


def safe_move(joints, label="?"):
    """Move to joint positions; logs and re-raises on failure."""
    log.info(f"→ Moving to {label}: {[round(j, 3) for j in joints]}")
    arm = getattr(_robot, "arm", _robot)  # SDK compatibility
    _call_first_available(arm, ["move_joints"], joints)
    log.info(f"  {label} reached ✔")


def close_gripper():
    """Close gripper on the current tool."""
    tool = getattr(_robot, "tool", None)
    candidates = [tool, _robot]
    method_names = ["grasp_with_tool", "close_gripper", "gripper_close", "grasp", "close"]

    last_exc = None
    for target in candidates:
        if target is None:
            continue
        for name in method_names:
            fn = getattr(target, name, None)
            if not callable(fn):
                continue
            try:
                # Some SDKs require a speed argument, others don't.
                return fn(GRIPPER_SPEED)
            except TypeError as exc:
                try:
                    return fn()
                except Exception as exc2:
                    last_exc = exc2
            except Exception as exc:
                last_exc = exc

    raise AttributeError(
        f"Gripper close method not available (tried {method_names})"
        + (f": {last_exc}" if last_exc else "")
    )


def open_gripper():
    """Open gripper on the current tool."""
    tool = getattr(_robot, "tool", None)
    candidates = [tool, _robot]
    method_names = ["release_with_tool", "open_gripper", "gripper_open", "release", "open"]

    last_exc = None
    for target in candidates:
        if target is None:
            continue
        for name in method_names:
            fn = getattr(target, name, None)
            if not callable(fn):
                continue
            try:
                return fn(GRIPPER_SPEED)
            except TypeError as exc:
                try:
                    return fn()
                except Exception as exc2:
                    last_exc = exc2
            except Exception as exc:
                last_exc = exc

    raise AttributeError(
        f"Gripper open method not available (tried {method_names})"
        + (f": {last_exc}" if last_exc else "")
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PICK & PLACE  — full defective-item cycle
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def execute_pick_and_place(item_id, confidence):
    """
    Execute one full pick-and-place cycle for a defective item.

    Path:
      READING [pick] → PATH_POINT → ABOVE_BIN [release]
      → PATH_POINT → READING
    """
    global _robot_busy, _last_action

    if not ensure_robot_ready():
        log.warning(f"Skipping pick for item {item_id} â€” robot not ready")
        _notify_backend_action(item_id, "pick_error", "robot_not_ready")
        return

    with _state_lock:
        if False and (not _robot_ok or _robot is None):
            log.warning(f"Skipping pick for item {item_id} — robot not ready")
            return
        _robot_busy  = True
        _last_action = f"picking item {item_id} (conf {confidence:.1%})"

    try:
        log.info(f"━━━ PICK & PLACE  item={item_id}  conf={confidence:.1%} ━━━")

        # ── PICK ────────────────────────────────────────────────────
        log.info("Opening gripper for pickup …")
        open_gripper()
        time.sleep(0.2)
        log.info("Grasping item …")
        close_gripper()
        time.sleep(GRIPPER_HOLD_MS / 1000.0)
        log.info("Item grasped ✔")

        # ── READING → PATH_POINT ────────────────────────────────────
        safe_move(PATH_JOINTS, label="PATH_POINT")

        # ── PATH_POINT → ABOVE_BIN ──────────────────────────────────
        safe_move(ABOVE_BIN_JOINTS, label="ABOVE_BIN")

        # ── RELEASE ─────────────────────────────────────────────────
        log.info("Releasing item into bin …")
        open_gripper()
        time.sleep(GRIPPER_RELEASE_MS / 1000.0)
        log.info("Closing gripper after release …")
        close_gripper()
        time.sleep(0.2)
        log.info("Item released ✔")

        # ── ABOVE_BIN → PATH_POINT ──────────────────────────────────
        safe_move(PATH_JOINTS, label="PATH_POINT (return)")

        # ── PATH_POINT → READING ────────────────────────────────────
        safe_move(READING_JOINTS, label="READING (return)")

        log.info("━━━ Cycle complete — waiting for next item ━━━")
        _notify_backend_action(item_id, "pick_complete")

    except Exception as exc:
        log.error(f"Pick & place failed for item {item_id}: {exc}")
        _notify_backend_action(item_id, "pick_error", str(exc))
        # Attempt to recover to reading position
        try:
            open_gripper()
            close_gripper()
            safe_move(READING_JOINTS, label="READING (recovery)")
        except Exception as rec_exc:
            log.error(f"Recovery move failed: {rec_exc}")

    finally:
        with _state_lock:
            _robot_busy  = False
            _last_action = "idle"
        release_robot_connection("pick-place cycle complete")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# WORKER THREAD  — drains the action queue
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def worker_loop():
    """Background thread: waits for items in the action queue and runs pick cycles."""
    log.info("Worker thread started — waiting for inspection results …")
    while True:
        try:
            item = _action_queue.get(timeout=POLL_INTERVAL_S)
            item_id    = item.get("id", "unknown")
            confidence = float(item.get("confidence", 0))

            execute_pick_and_place(item_id, confidence)

            _action_queue.task_done()
        except queue_module.Empty:
            pass  # nothing to do, loop again
        except Exception as exc:
            log.error(f"Worker loop error: {exc}")
            time.sleep(1.0)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HTTP SERVER  — receives inspection results from Node.js
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app = Flask(__name__)
CORS(app)


@app.route("/inspection-result", methods=["POST"])
def receive_inspection_result():
    """
    Called by Node.js backend when an inspection result arrives.
    Only DEFECTIVE items are queued for pick-and-place.

    Expected JSON body:
      { "id": "...", "label": "defective", "confidence": 0.95 }
    """
    data       = request.get_json(force=True) or {}
    label      = str(data.get("label", "")).lower()
    item_id    = data.get("id", "unknown")
    confidence = float(data.get("confidence", 0))

    log.info(f"Received inspection result: id={item_id}  label={label}  conf={confidence:.1%}")

    if label == "defective":
        with _state_lock:
            robot_ready = True

        if False and not robot_ready:
            if not ensure_robot_ready():
                log.warning("Robot not ready — defective item cannot be picked")
                return jsonify({"queued": False, "reason": "robot_not_ready"}), 503

        try:
            _action_queue.put_nowait({"id": item_id, "confidence": confidence})
            log.info(f"Item {item_id} queued for pick-and-place (queue size: {_action_queue.qsize()})")
            return jsonify({"queued": True, "queue_size": _action_queue.qsize()})
        except queue_module.Full:
            log.warning("Action queue full — dropping item")
            return jsonify({"queued": False, "reason": "queue_full"}), 429
    else:
        log.info(f"Item {item_id} is OK — passing on conveyor, no action needed")
        return jsonify({"queued": False, "reason": "ok_item"})


@app.route("/freemotion/enable", methods=["POST"])
def enable_freemotion():
    """Put the robot arm into learning/free-motion mode (gravity-compensated)."""
    global _freemotion_active
    with _state_lock:
        if not _robot_ok or _robot is None:
            return jsonify({"error": "robot_not_ready"}), 503
        if _robot_busy:
            return jsonify({"error": "robot_busy"}), 409
        try:
            _robot.arm.set_learning_mode(True)
            _freemotion_active = True
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
    log.info("Free motion ENABLED — arm is free to move")
    return jsonify({"freemotion": True})


@app.route("/freemotion/disable", methods=["POST"])
def disable_freemotion():
    """Exit free-motion mode; motors re-engage."""
    global _freemotion_active
    with _state_lock:
        _freemotion_active = False
        if _robot_ok and _robot is not None:
            try:
                _robot.arm.set_learning_mode(False)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 500
    log.info("Free motion DISABLED — motors engaged")
    return jsonify({"freemotion": False})


@app.route("/current-joints", methods=["GET"])
def get_current_joints():
    """Return the current joint angles (radians) read from the robot."""
    with _state_lock:
        if not _robot_ok or _robot is None:
            return jsonify({"error": "robot_not_ready"}), 503
        try:
            arm = getattr(_robot, "arm", _robot)  # SDK compatibility
            joints = list(_call_first_available(arm, ["get_joints"]))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
    log.info(f"Current joints read: {[round(j, 4) for j in joints]}")
    return jsonify({"joints": joints})


def _call_first_available(target, method_names, *args, **kwargs):
    """
    Try a list of API method names and call the first one found.
    This shields us from minor pyniryo API naming differences.
    """
    for name in method_names:
        fn = getattr(target, name, None)
        if callable(fn):
            return fn(*args, **kwargs)
    raise AttributeError(f"None of methods {method_names} are available on {type(target).__name__}")


def _set_stream_camera_paused(paused: bool) -> bool:
    endpoint = "/camera/pause" if paused else "/camera/resume"
    action = "pause" if paused else "resume"
    try:
        req = urllib.request.Request(
            f"{STREAM_SERVICE_URL}{endpoint}",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:
        log.warning(f"Unable to {action} stream camera: {exc}")
        return False


def _stream_robot_connected() -> bool:
    try:
        with urllib.request.urlopen(f"{STREAM_SERVICE_URL}/robot-health", timeout=2) as resp:
            import json
            data = json.loads(resp.read().decode("utf-8"))
            return bool(data.get("robot_connected"))
    except Exception:
        return False


def _hardware_status_to_dict(hw):
    """Best-effort conversion of pyniryo hardware status object to dict."""
    if hw is None:
        return {}
    if isinstance(hw, dict):
        return hw
    if hasattr(hw, "__dict__"):
        return {k: v for k, v in vars(hw).items() if not k.startswith("_")}
    return {}


def _collect_robot_diagnostics():
    """
    Collect diagnostics aligned with Niryo SDK semantics.
    Returns: (need_calib: bool, hardware_status: dict, alerts: list[dict])
    """
    need_calib = False
    hardware_status = {}
    alerts = []

    with _state_lock:
        robot = _robot
        robot_ok = _robot_ok
        session_mode = _robot_session_mode

    if not robot_ok or robot is None:
        if session_mode == "standby" and _stream_robot_connected():
            hardware_status = {"session_mode": "standby"}
            return need_calib, hardware_status, alerts
        alerts.append({"level": "error", "code": "robot_not_ready", "message": "Robot not ready"})
        return need_calib, hardware_status, alerts

    try:
        need_calib = bool(_call_first_available(robot, ["need_calibration"]))
        if need_calib:
            alerts.append({"level": "warning", "code": "needs_calibration", "message": "Robot requires calibration"})
    except Exception as exc:
        alerts.append({"level": "warning", "code": "need_calibration_check_failed", "message": str(exc)})

    try:
        raw_hw = _call_first_available(robot, ["get_hardware_status"])
        hardware_status = _hardware_status_to_dict(raw_hw)
    except Exception as exc:
        alerts.append({"level": "warning", "code": "hardware_status_unavailable", "message": str(exc)})

    # Surface common error fields if present (similar spirit to Studio diagnostics).
    for key in ["error_message", "hardware_errors_message", "rpi_temperature", "connection_up"]:
        if key in hardware_status and hardware_status.get(key):
            val = hardware_status.get(key)
            if key in ["error_message", "hardware_errors_message"]:
                alerts.append({"level": "error", "code": key, "message": str(val)})
            else:
                alerts.append({"level": "info", "code": key, "message": f"{key}: {val}"})

    return need_calib, hardware_status, alerts


@app.route("/reboot-tool", methods=["POST"])
def reboot_tool():
    """Reboot/reinitialize the end-effector tool (gripper)."""
    global _last_action
    if not ensure_robot_ready():
        return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        if _robot_busy:
            return jsonify({"message": "robot_busy"}), 409
        try:
            _last_action = "reboot_tool"
            # Niryo-studio equivalent: reboot the tool bus then refresh tool.
            _call_first_available(_robot, ["tool_reboot"])
            _call_first_available(_robot.tool, ["update_tool", "refresh_tool"])
            tool_name = getattr(_robot.tool, "tool", "unknown")
            msg = f"Tool rebooted ({tool_name})"
            log.info(msg)
            return jsonify({"message": msg})
        except Exception as exc:
            log.error(f"Tool reboot failed: {exc}")
            return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@app.route("/reboot-motors", methods=["POST"])
def reboot_motors():
    """Reboot/enable motors, then restore speed and return to reading pose."""
    global _last_action
    if not ensure_robot_ready():
        return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        if _robot_busy:
            return jsonify({"message": "robot_busy"}), 409

        _last_action = "reboot_motors"
        try:
            # Prefer direct reboot method if exposed by SDK/runtime.
            try:
                _call_first_available(_robot, ["reboot_motors"])
            except Exception:
                _call_first_available(
                    _robot.arm,
                    ["reboot_motors", "reboot_motor", "reboot", "reboot_arm"],
                )
            time.sleep(1.0)
            _call_first_available(_robot, ["set_learning_mode"], False)
            _robot.arm.set_arm_max_velocity(MOVE_SPEED)
            try:
                if bool(_call_first_available(_robot, ["need_calibration"])):
                    log.info("Motors reboot requires calibration — running auto calibration …")
                    _call_first_available(_robot, ["calibrate_auto", "calibrate"])
            except Exception as diag_exc:
                log.warning(f"Post-reboot calibration check failed: {diag_exc}")
            safe_move(READING_JOINTS, label="READING (after motors reboot)")
            msg = "Motors reboot complete"
            log.info(msg)
            return jsonify({"message": msg})
        except Exception as exc:
            log.error(f"Motors reboot failed: {exc}")
            return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@app.route("/calibrate", methods=["POST"])
def calibrate_robot():
    """Run automatic calibration and restore standard operating pose."""
    global _robot_ok, _last_action, _freemotion_active
    if not ensure_robot_ready():
        return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        if _robot is None:
            return jsonify({"message": "robot_not_ready"}), 503
        if _robot_busy:
            return jsonify({"message": "robot_busy"}), 409

        prev_ready = _robot_ok
        _last_action = "calibrating"
        try:
            _call_first_available(_robot, ["set_learning_mode"], False)
            _freemotion_active = False
            need_calib = bool(_call_first_available(_robot, ["need_calibration"]))
            if need_calib:
                _call_first_available(_robot, ["calibrate_auto", "calibrate"])
            else:
                log.info("Calibration not required according to robot diagnostics")
            _robot.arm.set_arm_max_velocity(MOVE_SPEED)
            safe_move(HOME_JOINTS, label="HOME (after calibration)")
            safe_move(READING_JOINTS, label="READING (after calibration)")
            _robot_ok = True
            msg = "Calibration complete" if need_calib else "Calibration not required; pose reset complete"
            log.info(msg)
            return jsonify({"message": msg})
        except Exception as exc:
            _robot_ok = prev_ready
            log.error(f"Calibration failed: {exc}")
            return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@app.route("/emergency-stop", methods=["POST"])
def emergency_stop():
    """Immediate stop command for robot motion."""
    global _robot_busy, _last_action
    if not ensure_robot_ready():
        return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        _last_action = "emergency_stop"
        try:
            _call_first_available(
                getattr(_robot, "arm", _robot),
                ["stop_move", "stop", "emergency_stop", "halt"],
            )
            _robot_busy = False
            msg = "Emergency stop executed"
            log.warning(msg)
            return jsonify({"message": msg})
        except Exception as exc:
            log.error(f"Emergency stop failed: {exc}")
            return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@app.route("/status", methods=["GET"])
def get_status():
    """Robot arm status — polled by Node.js for dashboard display."""
    need_calib, hardware_status, alerts = _collect_robot_diagnostics()
    with _state_lock:
        robot_connected = _robot_ok or (_robot_session_mode == "standby" and _stream_robot_connected())
        return jsonify({
            "robot_connected":    robot_connected,
            "robot_busy":         _robot_busy,
            "freemotion_active":  _freemotion_active,
            "last_action":        _last_action,
            "queue_size":         _action_queue.qsize(),
            "need_calibration":   need_calib,
            "hardware_status":    hardware_status,
            "alerts":             alerts,
            "session_mode":       _robot_session_mode,
        })


@app.route("/health", methods=["GET"])
def health():
    with _state_lock:
        session_mode = _robot_session_mode
        ok = _robot_ok or (session_mode == "standby" and _stream_robot_connected())
    return jsonify({"status": "ok" if ok else "offline", "robot_connected": ok, "session_mode": session_mode})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# BACKEND NOTIFICATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _notify_backend_action(item_id, action, error=None):
    """
    Notify Node.js that the robot completed (or failed) an action.
    Node.js will broadcast this via Socket.IO to the dashboard.
    Fire-and-forget — failures here must not crash the robot thread.
    """
    try:
        import requests as req
        payload = {"item_id": item_id, "action": action}
        if error:
            payload["error"] = error
        req.post(
            f"{BACKEND_URL}/api/robot/action-result",
            json=payload,
            timeout=2,
        )
    except Exception:
        pass  # backend notification is best-effort only


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MAIN
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if __name__ == "__main__":
    log.info(
        "\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        " Niryo Pick & Place Controller\n"
        f"  Robot IP   : {ROBOT_IP}\n"
        f"  HTTP port  : {ROBOT_SERVICE_PORT}\n"
        f"  Move speed : {MOVE_SPEED}%\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "  JOINT POSITIONS STILL SET TO PLACEHOLDER 0.0\n"
        "  → Set HOME, READING, PATH_POINT, ABOVE_BIN\n"
        "    joint values before running in production!\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    )

    # 1 — Start worker thread (processes the action queue)
    worker = threading.Thread(target=worker_loop, daemon=True)
    worker.start()

    # 2 — Connect to robot in background so HTTP server starts immediately
    def robot_init():
        return
        backoff = 5
        while True:
            try:
                connect_robot()
                break
            except Exception:
                log.info(f"Retrying robot connection in {backoff}s …")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)

    robot_thread = threading.Thread(target=robot_init, daemon=True)
    robot_thread.start()

    # 3 — Start HTTP server (always available, even while robot connects)
    log.info(f"HTTP server starting on http://0.0.0.0:{ROBOT_SERVICE_PORT}")
    app.run(host="0.0.0.0", port=ROBOT_SERVICE_PORT, threaded=True)
