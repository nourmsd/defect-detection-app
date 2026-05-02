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
from flask import Flask, request, jsonify
from flask_cors import CORS

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CONFIGURATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ROBOT_IP             = "10.10.10.10"   # Niryo default hotspot IP
ROBOT_SERVICE_PORT   = 5002            # this script's HTTP port
BACKEND_URL          = "http://127.0.0.1:5000"  # Node.js backend

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
    0.0,    # joint_1  ← TODO set manually
    0.5,    # joint_2  ← TODO set manually
   -1.25,   # joint_3  ← TODO set manually
    0.0,    # joint_4  ← TODO set manually
   -0.5,    # joint_5  ← TODO set manually
    0.0,    # joint_6  ← TODO set manually
]

# ── 2. READING ───────────────────────────────────────────────────────
#  Gripper positioned ON the product sitting on the conveyor inspection
#  zone — robot is ready to either pick (defective) or release (OK)
READING_JOINTS = [
    0.0,    # joint_1  ← TODO set manually
    0.0,    # joint_2  ← TODO set manually
    0.0,    # joint_3  ← TODO set manually
    0.0,    # joint_4  ← TODO set manually
    0.0,    # joint_5  ← TODO set manually
    0.0,    # joint_6  ← TODO set manually
]

# ── 3. PATH_POINT ────────────────────────────────────────────────────
#  Intermediate clearance waypoint between reading zone and reject bin.
#  Must be high enough to clear the conveyor frame and any obstacles.
#  The robot passes through this point in BOTH directions.
PATH_JOINTS = [
    0.0,    # joint_1  ← TODO set manually
    0.0,    # joint_2  ← TODO set manually
    0.0,    # joint_3  ← TODO set manually
    0.0,    # joint_4  ← TODO set manually
    0.0,    # joint_5  ← TODO set manually
    0.0,    # joint_6  ← TODO set manually
]

# ── 4. ABOVE_BIN ─────────────────────────────────────────────────────
#  Directly above the reject bin, gripper pointing downward.
#  Robot will release (open gripper) while in this position.
ABOVE_BIN_JOINTS = [
    0.0,    # joint_1  ← TODO set manually
    0.0,    # joint_2  ← TODO set manually
    0.0,    # joint_3  ← TODO set manually
    0.0,    # joint_4  ← TODO set manually
    0.0,    # joint_5  ← TODO set manually
    0.0,    # joint_6  ← TODO set manually
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


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ROBOT CONNECTION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def connect_robot():
    """Connect to Niryo robot via pyniryo2 and update shared state."""
    global _robot, _robot_ok

    try:
        from pyniryo2 import NiryoRobot
        log.info(f"Connecting to Niryo robot at {ROBOT_IP} …")
        robot = NiryoRobot(ROBOT_IP)
        log.info("Robot TCP connected ✔")

        log.info("Calibrating …")
        robot.arm.calibrate_auto()
        log.info("Calibration done ✔")

        robot.arm.set_arm_max_velocity(MOVE_SPEED)
        robot.tool.update_tool()
        log.info(f"Tool detected: {robot.tool.tool}")

        with _state_lock:
            _robot   = robot
            _robot_ok = True

        log.info("Moving to HOME position …")
        safe_move(HOME_JOINTS, label="HOME")
        log.info("Robot ready — moving to READING position")
        safe_move(READING_JOINTS, label="READING")

    except Exception as exc:
        log.error(f"Robot connection failed: {exc}")
        with _state_lock:
            _robot    = None
            _robot_ok = False
        raise


def safe_move(joints, label="?"):
    """Move to joint positions; logs and re-raises on failure."""
    log.info(f"→ Moving to {label}: {[round(j, 3) for j in joints]}")
    _robot.arm.move_joints(joints)
    log.info(f"  {label} reached ✔")


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

    with _state_lock:
        if not _robot_ok or _robot is None:
            log.warning(f"Skipping pick for item {item_id} — robot not ready")
            return
        _robot_busy  = True
        _last_action = f"picking item {item_id} (conf {confidence:.1%})"

    try:
        log.info(f"━━━ PICK & PLACE  item={item_id}  conf={confidence:.1%} ━━━")

        # ── PICK ────────────────────────────────────────────────────
        log.info("Grasping item …")
        _robot.tool.grasp_with_tool()
        time.sleep(GRIPPER_HOLD_MS / 1000.0)
        log.info("Item grasped ✔")

        # ── READING → PATH_POINT ────────────────────────────────────
        safe_move(PATH_JOINTS, label="PATH_POINT")

        # ── PATH_POINT → ABOVE_BIN ──────────────────────────────────
        safe_move(ABOVE_BIN_JOINTS, label="ABOVE_BIN")

        # ── RELEASE ─────────────────────────────────────────────────
        log.info("Releasing item into bin …")
        _robot.tool.release_with_tool()
        time.sleep(GRIPPER_RELEASE_MS / 1000.0)
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
            _robot.tool.release_with_tool()
            safe_move(READING_JOINTS, label="READING (recovery)")
        except Exception as rec_exc:
            log.error(f"Recovery move failed: {rec_exc}")

    finally:
        with _state_lock:
            _robot_busy  = False
            _last_action = "idle"


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
            robot_ready = _robot_ok

        if not robot_ready:
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
            joints = list(_robot.arm.get_joints())
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
    log.info(f"Current joints read: {[round(j, 4) for j in joints]}")
    return jsonify({"joints": joints})


@app.route("/status", methods=["GET"])
def get_status():
    """Robot arm status — polled by Node.js for dashboard display."""
    with _state_lock:
        return jsonify({
            "robot_connected":    _robot_ok,
            "robot_busy":         _robot_busy,
            "freemotion_active":  _freemotion_active,
            "last_action":        _last_action,
            "queue_size":         _action_queue.qsize(),
        })


@app.route("/health", methods=["GET"])
def health():
    with _state_lock:
        ok = _robot_ok
    return jsonify({"status": "ok" if ok else "offline", "robot_connected": ok})


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
