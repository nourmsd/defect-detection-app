"""
Robot module: Niryo connection management, motion primitives, pick-and-place,
worker thread, backend/event-bus helpers, and the Flask HTTP API on :5002.
All shared mutable robot globals live here at module scope.
"""

import json
import queue as queue_module
import threading
import time
import urllib.request
import uuid
from datetime import datetime
from typing import List, Optional, Tuple

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request
from flask_cors import CORS

from config import (
    log,
    ROBOT_IP, ROBOT_SERVICE_PORT, BACKEND_URL, STREAM_SERVICE_URL,
    NIRYO_HEALTH_URL,
    PIPELINE_EVENT_PREFIX,
    GRIPPER_SPEED, POLL_INTERVAL_S,
    INSPECTION_POSE, PICK_POSE, INTER_POSE1, INTER_POSE2, REJECT_BIN_POSE,
)
import os


# ═══════════════════════════════════════════════════════════════════════════════
# SHARED FLASK APPLICATION (Robot HTTP API)
# ═══════════════════════════════════════════════════════════════════════════════

robot_app = Flask("robot_service")
CORS(robot_app)

# Stream Flask: replaces the standalone niryo_stream.py process. Runs on :5001
# and serves the Niryo robot's camera feed using the SAME pyniryo connection
# we hold for motion. One process = one TCP slot on robot port 40001 — no more
# "second connection hangs forever" race.
stream_app = Flask("stream_service")
CORS(stream_app)


# ═══════════════════════════════════════════════════════════════════════════════
# ROBOT STATE
# ═══════════════════════════════════════════════════════════════════════════════

_state_lock           = threading.Lock()
_robot                = None
_robot_ok             = False
_last_action          = "idle"
_action_queue         = queue_module.Queue(maxsize=20)
_recovery_in_progress = False
_robot_session_mode   = "standby"

# Reference expiry cutoff supplied by the web app via POST /reference-date.
# A detected expiry date strictly earlier than this cutoff → defect_type="expired".
_reference_date_lock: threading.Lock      = threading.Lock()
_reference_date:      Optional[str]       = os.environ.get("REFERENCE_DATE") or None

# Camera grabber state — lives in robot.py because only the NiryoRobot can fetch
# frames. AI consumers read these via qualified access (robot._camera_frame_bgr).
_camera_lock         = threading.Lock()
_camera_jpeg_bytes:  Optional[bytes]      = None   # latest JPEG from get_img_compressed()
_camera_frame_bgr:   Optional[np.ndarray] = None   # decoded BGR for AI pipelines
_camera_frame_count: int                  = 0
_camera_paused                            = False
STREAM_SERVICE_PORT  = 5001                        # matches dashboard's hard-coded URL


# ═══════════════════════════════════════════════════════════════════════════════
# ROBOT UTILITY HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _call_first_available(target, method_names, *args, **kwargs):
    for name in method_names:
        fn = getattr(target, name, None)
        if callable(fn):
            return fn(*args, **kwargs)
    raise AttributeError(
        f"None of methods {method_names} are available on {type(target).__name__}"
    )


def _set_stream_camera_paused(paused: bool) -> bool:
    endpoint = "/camera/pause" if paused else "/camera/resume"
    try:
        req = urllib.request.Request(
            f"{STREAM_SERVICE_URL}{endpoint}", data=b"{}",
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:
        log.warning(f"Unable to {'pause' if paused else 'resume'} stream camera: {exc}")
        return False


def _stream_robot_connected() -> bool:
    try:
        with urllib.request.urlopen(f"{STREAM_SERVICE_URL}/robot-health", timeout=2) as resp:
            return bool(json.loads(resp.read().decode()).get("robot_connected"))
    except Exception:
        return False


def _check_stream_reachable() -> bool:
    try:
        req = urllib.request.Request(NIRYO_HEALTH_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            json.loads(resp.read())
            return True
    except Exception:
        return False


def _check_robot_connected_via_health() -> bool:
    try:
        req = urllib.request.Request(NIRYO_HEALTH_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            return bool(json.loads(resp.read()).get("robot_connected", False))
    except Exception:
        return False


def _hardware_status_to_dict(hw) -> dict:
    if hw is None:           return {}
    if isinstance(hw, dict): return hw
    if hasattr(hw, "__dict__"):
        return {k: v for k, v in vars(hw).items() if not k.startswith("_")}
    return {}


def _collect_robot_diagnostics() -> Tuple[bool, dict, list]:
    need_calib, hardware_status, alerts = False, {}, []
    with _state_lock:
        robot, robot_ok, session_mode = _robot, _robot_ok, _robot_session_mode

    if not robot_ok or robot is None:
        # Don't emit a "robot_not_ready" alert — the dashboard's connectivity
        # indicator already covers this state. Alerts list stays empty so the
        # operator only sees actionable issues (temperature, calibration,
        # motors, collision, emergency stop).
        return need_calib, hardware_status, alerts

    try:
        need_calib = bool(_call_first_available(robot, ["need_calibration"]))
        if need_calib:
            alerts.append({"level": "warning", "code": "needs_calibration",
                           "message": "Robot requires calibration"})
    except Exception as exc:
        alerts.append({"level": "warning", "code": "need_calibration_check_failed",
                       "message": str(exc)})

    try:
        hardware_status = _hardware_status_to_dict(
            _call_first_available(robot, ["get_hardware_status"])
        )
    except Exception as exc:
        alerts.append({"level": "warning", "code": "hardware_status_unavailable",
                       "message": str(exc)})

    for key in ["error_message", "hardware_errors_message", "rpi_temperature", "connection_up"]:
        if key in hardware_status and hardware_status.get(key):
            level = "error" if key in ("error_message", "hardware_errors_message") else "info"
            alerts.append({"level": level, "code": key,
                           "message": f"{key}: {hardware_status[key]}"})

    return need_calib, hardware_status, alerts


# ═══════════════════════════════════════════════════════════════════════════════
# ROBOT CONNECTION MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════════

def connect_robot() -> None:
    global _robot, _robot_ok, _robot_session_mode
    with _state_lock:
        _robot_session_mode = "connecting"

    try:
        from pyniryo import NiryoRobot
        log.info(f"Connecting to Niryo robot at {ROBOT_IP} …")
        robot = NiryoRobot(ROBOT_IP)
        log.info("Robot TCP connected ✔")

        # Verified-working boot sequence: calibrate → update_tool → INSPECTION_POSE.
        # Plain pyniryo top-level methods, no learning-mode toggle, no need_calibration check.
        log.info("Calibrating …")
        robot.calibrate_auto()
        log.info("Updating tool …")
        robot.update_tool()

        with _state_lock:
            _robot, _robot_ok, _robot_session_mode = robot, True, "active"

        log.info("Moving to INSPECTION_POSE …")
        robot.move_pose(INSPECTION_POSE)
        log.info("✅ Robot fully ready at INSPECTION_POSE")
        # Start the in-process camera grabber so the AI pipeline and the :5001
        # /stream endpoint can both consume frames from this single connection.
        start_camera_thread()

    except Exception as exc:
        log.error(f"Robot connection failed: {exc}", exc_info=True)
        with _state_lock:
            _robot, _robot_ok = None, False
            _robot_session_mode = "standby"
        raise

def release_robot_connection(reason: str = "standby") -> None:
    global _robot, _robot_ok, _robot_session_mode
    with _state_lock:
        robot = _robot
        _robot, _robot_ok, _robot_session_mode = None, False, "standby"
    if robot is not None:
        try:
            close_fn = getattr(robot, "close_connection", None)
            if callable(close_fn):
                close_fn()
                log.info(f"Released robot connection — {reason}")
        except Exception as exc:
            log.warning(f"Robot disconnect warning: {exc}")


def reconnect_robot_socket(reason: str = "camera desync") -> bool:
    """Lightweight socket-only reconnect. Closes the existing NiryoRobot TCP
    connection and opens a fresh one WITHOUT calibrating or moving the arm —
    used to recover from pyniryo byte-stream desync (the 'utf-8 codec can't
    decode byte 0xff' error after long sessions). The robot is left wherever
    it currently is. Returns True on success.

    Holds _state_lock during the swap so motion/action-queue code that grabs
    _robot mid-reconnect either sees the old reference (about to close) or the
    new one (already valid) — never a half-built object.
    """
    global _robot, _robot_ok
    log.warning(f"[reconnect] Rebuilding robot TCP socket — {reason}")
    with _state_lock:
        old = _robot
        _robot, _robot_ok = None, False
    if old is not None:
        try:
            close_fn = getattr(old, "close_connection", None)
            if callable(close_fn):
                close_fn()
        except Exception as exc:
            log.warning(f"[reconnect] old socket close warning: {exc}")
    try:
        from pyniryo import NiryoRobot
        new_robot = NiryoRobot(ROBOT_IP)
        with _state_lock:
            _robot, _robot_ok = new_robot, True
        log.info("[reconnect] Robot TCP re-established ✔")
        return True
    except Exception as exc:
        log.error(f"[reconnect] Failed to rebuild socket: {exc}")
        with _state_lock:
            _robot, _robot_ok = None, False
        return False


def ensure_robot_ready() -> bool:
    global _recovery_in_progress
    with _state_lock:
        if _robot_ok and _robot is not None:
            return True

        log.warning(f"[ensure_robot_ready] Robot not ready: _robot_ok={_robot_ok}, "
                    f"_recovery_in_progress={_recovery_in_progress}")

        if _recovery_in_progress:
            # Wait for ongoing recovery
            deadline = time.time() + 40
            while time.time() < deadline:
                with _state_lock:
                    if _robot_ok and _robot is not None:
                        return True
                time.sleep(0.5)
            return False

        _recovery_in_progress = True

    try:
        log.warning("Robot not ready — attempting automatic recovery …")
        connect_robot()                    # This already does calibration + move to READING
        time.sleep(2.5)                    # Give robot time to stabilize
        log.info("Robot recovery completed")
        return True
    except Exception as exc:
        log.error(f"Automatic recovery failed: {exc}", exc_info=True)
        return False
    finally:
        with _state_lock:
            _recovery_in_progress = False


# ═══════════════════════════════════════════════════════════════════════════════
# ROBOT MOTION PRIMITIVES
# ═══════════════════════════════════════════════════════════════════════════════

def safe_move(pose, label: str = "?") -> None:
    """Cartesian move using PoseObject + robot.move_pose (the verified-working API)."""
    log.info(f"→ Moving to {label}")
    _robot.move_pose(pose)
    log.info(f"  {label} reached ✔")


def close_gripper() -> None:
    tool, last_exc = getattr(_robot, "tool", None), None
    for target in [tool, _robot]:
        if target is None: continue
        for name in ["grasp_with_tool", "close_gripper", "gripper_close", "grasp", "close"]:
            fn = getattr(target, name, None)
            if not callable(fn): continue
            try:    return fn(GRIPPER_SPEED)
            except TypeError:
                try: return fn()
                except Exception as e: last_exc = e
            except Exception as e: last_exc = e
    raise AttributeError(f"Gripper close not available" + (f": {last_exc}" if last_exc else ""))


def open_gripper() -> None:
    tool, last_exc = getattr(_robot, "tool", None), None
    for target in [tool, _robot]:
        if target is None: continue
        for name in ["release_with_tool", "open_gripper", "gripper_open", "release", "open"]:
            fn = getattr(target, name, None)
            if not callable(fn): continue
            try:    return fn(GRIPPER_SPEED)
            except TypeError:
                try: return fn()
                except Exception as e: last_exc = e
            except Exception as e: last_exc = e
    raise AttributeError(f"Gripper open not available" + (f": {last_exc}" if last_exc else ""))


def recalibrate_gripper() -> bool:
    """Resets the tool connection to fix stalling/partial opening.
    Verified-working sequence: update_tool → 1s settle → open_gripper(speed=500)."""
    if _robot is None:
        log.warning("[gripper] Cannot recalibrate — robot not connected.")
        return False
    log.warning("[gripper] Resetting gripper connection …")
    try:
        _robot.update_tool()                # force-refresh tool recognition
        time.sleep(1.0)
        _robot.open_gripper(speed=500)      # full open to a known state
        log.info("[gripper] Gripper recalibrated.")
        return True
    except Exception as exc:
        log.error(f"[gripper] Recalibration failed: {exc}")
        return False


_GRIPPER_TIMEOUT_S = 5.0   # max time to wait for a gripper call before declaring stall


def _call_with_timeout(fn, timeout_s: float, label: str):
    """Run fn() in a daemon thread; raise TimeoutError if it doesn't return
    within timeout_s. The thread keeps running (we can't kill a stuck pyniryo
    socket cleanly) but the worker is no longer blocked."""
    holder: dict = {"exc": None, "done": False}
    def _target():
        try:
            fn()
            holder["done"] = True
        except Exception as e:
            holder["exc"] = e
    t = threading.Thread(target=_target, daemon=True, name=f"gripper-{label}")
    t.start()
    t.join(timeout=timeout_s)
    if not holder["done"] and holder["exc"] is None:
        raise TimeoutError(f"{label} did not return after {timeout_s:.1f}s — pyniryo socket likely stuck")
    if holder["exc"] is not None:
        raise holder["exc"]


def _gripper_safe(action_fn, label: str) -> None:
    """Run a gripper action with a 5s watchdog. On stall/timeout/error, reboot
    the tool once and retry. If recovery also stalls, raise so the worker can
    log it and move on instead of blocking forever."""
    try:
        _call_with_timeout(action_fn, _GRIPPER_TIMEOUT_S, label)
        return
    except Exception as exc:
        log.warning(f"[gripper] {label} failed ({exc}) — attempting recalibration.")
    try:
        # recalibrate_gripper itself is wrapped in a timeout — its update_tool
        # call is the most common stall source.
        _call_with_timeout(recalibrate_gripper, _GRIPPER_TIMEOUT_S, "recalibrate")
    except Exception as exc:
        log.error(f"[gripper] Recalibration timed out: {exc}")
        raise RuntimeError(f"Gripper {label} stalled and could not be recovered.")
    try:
        _call_with_timeout(action_fn, _GRIPPER_TIMEOUT_S, label)
        log.info(f"[gripper] {label} succeeded after recalibration.")
        return
    except Exception as exc:
        log.error(f"[gripper] {label} still failed after recalibration: {exc}")
        raise


# ═══════════════════════════════════════════════════════════════════════════════
# PICK & PLACE — Cartesian poses (verified-working pyniryo flow)
# ═══════════════════════════════════════════════════════════════════════════════

def execute_pick_and_place(item_id: str, confidence: float) -> None:
    log.info(f"━━━ START PICK & PLACE | Item={item_id} ━━━")

    # NOTE: skipping the unconditional recalibrate_gripper() here. It runs
    # update_tool() which can hang the pyniryo socket if called repeatedly in
    # a long-running pipeline. The individual gripper calls below are wrapped
    # in _gripper_safe(), which triggers recalibration only if a real stall
    # occurs — so we still get recovery without paying the upfront cost.

    # 1. Prepare to pick
    safe_move(PICK_POSE, label="PICK_POSE")
    time.sleep(0.5)

    # 2. Grasp
    _robot.grasp_with_tool()
    time.sleep(0.5)

    # 3. Path to bin (two intermediate poses to avoid collisions)
    safe_move(INTER_POSE1, label="INTER_POSE1")
    safe_move(INTER_POSE2, label="INTER_POSE2")

    # 4. Drop in bin
    safe_move(REJECT_BIN_POSE, label="REJECT_BIN_POSE")
    _robot.release_with_tool()
    _robot.open_gripper(speed=500)
    time.sleep(0.5)

    # 5. Return path
    safe_move(INTER_POSE2, label="INTER_POSE2 (return)")
    safe_move(INTER_POSE1, label="INTER_POSE1 (return)")
    safe_move(INSPECTION_POSE, label="INSPECTION_POSE")

    log.info(f"━━━ PICK & PLACE DONE for {item_id} ━━━")

# ═══════════════════════════════════════════════════════════════════════════════
# WORKER THREAD
# ═══════════════════════════════════════════════════════════════════════════════

def worker_loop() -> None:
    log.info("Worker thread started — waiting for inspection results …")
    while True:
        try:
            item       = _action_queue.get(timeout=POLL_INTERVAL_S)
            item_id    = item.get("id", "unknown")
            confidence = float(item.get("confidence", 0))
            log.info(f"[worker] Dequeued item {item_id} conf={confidence:.1%} -- starting pick-place")
            execute_pick_and_place(item_id, confidence)
            _action_queue.task_done()
        except queue_module.Empty:
            pass
        except Exception as exc:
            log.error(f"Worker loop error: {exc}")
            time.sleep(1.0)


# ═══════════════════════════════════════════════════════════════════════════════
# BACKEND / EVENT BUS HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _emit_pipeline_state(state: str, message: str) -> None:
    try:
        payload = {
            "status": state, "detected_date": "missing", "flavor": "missing",
            "confidence": 0.0, "yolo_detections": 0, "inference_ms": 0.0, "fps": 0.0,
            "pipeline_state": state, "message": message,
            "timestamp": datetime.now().astimezone().isoformat(),
        }
        print(
            f"{PIPELINE_EVENT_PREFIX}"
            f"{json.dumps({'type': 'inference_status', 'payload': payload}, ensure_ascii=False)}",
            flush=True,
        )
    except Exception:
        pass


def _say(text: str) -> None:
    def _run():
        with _state_lock:
            robot = _robot

        # ── 1) Try the robot's own TTS ────────────────────────────────────
        if robot is not None:
            tried: List[str] = []
            # Path A: robot.sound.say(text, lang)   (Ned 2 Sound API)
            sound = getattr(robot, "sound", None)
            if sound is not None:
                say_fn = getattr(sound, "say", None)
                if callable(say_fn):
                    for args in [(text, 1), (text, "english"), (text,)]:
                        try:
                            say_fn(*args)
                            log.info(f"[say] robot.sound.say -> {text!r}")
                            return
                        except Exception as exc:
                            tried.append(f"sound.say{args}: {exc}")
            # Path B: any direct method on the robot object
            for name in ("say", "speak", "tts", "play_tts"):
                fn = getattr(robot, name, None)
                if callable(fn):
                    try:
                        fn(text)
                        log.info(f"[say] robot.{name} -> {text!r}")
                        return
                    except Exception as exc:
                        tried.append(f"{name}: {exc}")
            if tried:
                log.debug(f"[say] robot TTS not available: {tried}")

        # ── 2) Fallback: PC TTS via Windows SAPI ──────────────────────────
        try:
            import subprocess
            safe = text.replace("'", " ").replace('"', " ")
            subprocess.Popen(
                ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
                 "Add-Type -AssemblyName System.Speech; "
                 "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                 "$s.Rate = 0; "
                 f"$s.Speak('{safe}')"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, shell=False,
            )
            log.info(f"[say] PC TTS -> {text!r}")
        except Exception as exc:
            log.warning(f"[say] No TTS available: {exc}")

    threading.Thread(target=_run, daemon=True, name="tts").start()


def post_result_to_backend(
    final_class:     str,
    overall_conf:    float,
    detected_date:   Optional[str],
    flavor_text:     Optional[str],
    processing_time: float,
    barcode:         Optional[str] = None,
    defect_type:     Optional[str] = None,
) -> None:
    bc   = (barcode or "").strip()
    date = (detected_date or "").strip()
    item_id = f"{bc}-{date}" if bc and date else (bc or date or str(uuid.uuid4()))
    label = "ok" if (final_class == "NORMAL" and not defect_type) else "defective"
    payload = {
        "id":              item_id,
        "flavor":          flavor_text or "missing",
        "expiry_date":     date or "missing",
        "barcode":         bc or "missing",
        "label":           label,
        "defect_type":     defect_type,        # null when label == "ok"
        "confidence":      round(float(overall_conf), 4),
        "processing_time": round(float(processing_time), 4),
        "timestamp":       datetime.now().astimezone().isoformat(),
    }
    try:
        print(
            f"{PIPELINE_EVENT_PREFIX}"
            f"{json.dumps({'type': 'inspection', 'payload': payload}, ensure_ascii=False)}",
            flush=True,
        )
    except Exception as exc:
        log.error(f"PIPELINE EVENT ERROR: {exc}")


def _notify_backend_action(item_id: str, action: str, error: Optional[str] = None) -> None:
    try:
        import requests as req
        payload = {"item_id": item_id, "action": action}
        if error: payload["error"] = error
        req.post(f"{BACKEND_URL}/api/robot/action-result", json=payload, timeout=2)
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════════
# ROBOT HTTP API  (:5002)
# ═══════════════════════════════════════════════════════════════════════════════

@robot_app.route("/inspection-result", methods=["POST"])
def receive_inspection_result():
    data       = request.get_json(force=True) or {}
    label      = str(data.get("label", "")).lower()
    item_id    = data.get("id", "unknown")
    confidence = float(data.get("confidence", 0))
    log.info(f"Inspection result received: id={item_id}  label={label}  conf={confidence:.1%}")
    if label == "defective":
        try:
            _action_queue.put_nowait({"id": item_id, "confidence": confidence})
            log.info(f"Item {item_id} queued (queue size: {_action_queue.qsize()})")
            return jsonify({"queued": True, "queue_size": _action_queue.qsize()})
        except queue_module.Full:
            log.warning("Action queue full — dropping item")
            return jsonify({"queued": False, "reason": "queue_full"}), 429
    else:
        log.info(f"Item {item_id} is OK — no robot action needed")
        return jsonify({"queued": False, "reason": "ok_item"})


@robot_app.route("/reboot-tool", methods=["POST"])
def reboot_tool():
    global _last_action
    if not ensure_robot_ready(): return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        try:
            _last_action = "reboot_tool"
            _call_first_available(_robot, ["tool_reboot"])
            _call_first_available(_robot.tool, ["update_tool", "refresh_tool"])
            msg = f"Tool rebooted ({getattr(_robot.tool,'tool','unknown')})"
            log.info(msg);  return jsonify({"message": msg})
        except Exception as exc:
            log.error(f"Tool reboot failed: {exc}");  return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@robot_app.route("/reboot-motors", methods=["POST"])
def reboot_motors():
    global _last_action
    if not ensure_robot_ready(): return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        _last_action = "reboot_motors"
        try:
            try:   _call_first_available(_robot, ["reboot_motors"])
            except Exception:
                _call_first_available(_robot.arm,
                    ["reboot_motors","reboot_motor","reboot","reboot_arm"])
            time.sleep(1.0)
            _robot.calibrate_auto()
            _robot.update_tool()
            safe_move(INSPECTION_POSE, label="INSPECTION_POSE (after motors reboot)")
            msg = "Motors reboot complete";  log.info(msg);  return jsonify({"message": msg})
        except Exception as exc:
            log.error(f"Motors reboot failed: {exc}");  return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@robot_app.route("/calibrate", methods=["POST"])
def calibrate_robot():
    global _robot_ok, _last_action
    if not ensure_robot_ready(): return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        if _robot is None: return jsonify({"message": "robot_not_ready"}), 503
        prev_ready = _robot_ok;  _last_action = "calibrating"
        try:
            _robot.calibrate_auto()
            _robot.update_tool()
            safe_move(INSPECTION_POSE, label="INSPECTION_POSE (after calibration)")
            _robot_ok = True
            msg = "Calibration complete"
            log.info(msg);  return jsonify({"message": msg})
        except Exception as exc:
            _robot_ok = prev_ready;  log.error(f"Calibration failed: {exc}")
            return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@robot_app.route("/emergency-stop", methods=["POST"])
def emergency_stop():
    global _last_action
    if not ensure_robot_ready(): return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        _last_action = "emergency_stop"
        try:
            _call_first_available(_robot,
                                  ["stop_move","stop","emergency_stop","halt"])
            msg = "Emergency stop executed"
            log.warning(msg);  return jsonify({"message": msg})
        except Exception as exc:
            log.error(f"Emergency stop failed: {exc}");  return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@robot_app.route("/status", methods=["GET"])
def get_status():
    need_calib, hardware_status, alerts = _collect_robot_diagnostics()
    with _state_lock:
        robot_connected = _robot_ok or (
            _robot_session_mode == "standby" and _stream_robot_connected()
        )
        return jsonify({
            "robot_connected":   robot_connected,
            "last_action":       _last_action,
            "queue_size":        _action_queue.qsize(),
            "need_calibration":  need_calib,
            "hardware_status":   hardware_status,
            "alerts":            alerts,
            "session_mode":      _robot_session_mode,
        })


@robot_app.route("/reference-date", methods=["GET", "POST"])
def reference_date_route():
    """GET → current cutoff. POST {"reference_date": "12 JAN"} → set it."""
    global _reference_date
    # Local import to avoid circular dependency at module load time.
    from ai import _parse_expiry_date

    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        raw  = body.get("reference_date")
        if raw is not None and not isinstance(raw, str):
            return jsonify({"error": "reference_date must be a string or null"}), 400
        if raw and _parse_expiry_date(raw) is None:
            return jsonify({"error": f"Unparsable date: {raw!r}. Use 'DD MMM' (e.g. '12 JAN')."}), 400
        with _reference_date_lock:
            _reference_date = (raw.strip() if raw else None)
            current = _reference_date
        log.info(f"[reference-date] updated → {current!r}")
        return jsonify({"reference_date": current})
    with _reference_date_lock:
        return jsonify({"reference_date": _reference_date})


@robot_app.route("/health", methods=["GET"])
def robot_health():
    with _state_lock:
        ok           = _robot_ok or (_robot_session_mode=="standby" and _stream_robot_connected())
        session_mode = _robot_session_mode
    return jsonify({"status": "ok" if ok else "offline",
                    "robot_connected": ok, "session_mode": session_mode})


def _start_robot_http_server() -> None:
    log.info(f"Robot HTTP service starting on http://0.0.0.0:{ROBOT_SERVICE_PORT}")
    robot_app.run(host="0.0.0.0", port=ROBOT_SERVICE_PORT, threaded=True)


# ═══════════════════════════════════════════════════════════════════════════════
# IN-PROCESS CAMERA GRABBER  (replaces standalone niryo_stream.py)
# ═══════════════════════════════════════════════════════════════════════════════
# This thread is the SOLE caller of robot.get_img_compressed(). It pumps JPEGs
# into a lock-protected slot consumed by both:
#   - AI pipelines: read decoded BGR frame (`get_camera_frame_bgr`)
#   - Stream HTTP route on :5001: read raw JPEG bytes (`/stream`)

def _camera_loop() -> None:
    global _camera_jpeg_bytes, _camera_frame_bgr, _camera_frame_count
    log.info("[camera] grabber thread started — pumping frames from robot.get_img_compressed()")
    fail_streak = 0
    # When the pyniryo TCP byte stream desyncs (utf-8 decode errors after a
    # long session), retrying the same socket does nothing — only a fresh
    # NiryoRobot() rebuild clears the protocol state. After ~3 s of failed
    # frames, rebuild the socket. The cooldown stops us from hammering reconnect
    # if the underlying issue is the robot being unreachable.
    RECONNECT_AFTER_STREAK = 30  # ~3 s at 100 ms retry interval
    RECONNECT_COOLDOWN_S   = 10.0
    last_reconnect_ts = 0.0
    while True:
        with _state_lock:
            robot = _robot
            paused = _camera_paused
        if robot is None or paused:
            time.sleep(0.2)
            continue
        try:
            jpeg = robot.get_img_compressed()
            if not jpeg:
                raise RuntimeError("empty JPEG returned")
            arr = np.frombuffer(jpeg, dtype=np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if frame is None or frame.size == 0:
                raise RuntimeError("imdecode returned None")
            with _camera_lock:
                _camera_jpeg_bytes  = jpeg if isinstance(jpeg, (bytes, bytearray)) else bytes(jpeg)
                _camera_frame_bgr   = frame
                _camera_frame_count += 1
            fail_streak = 0
        except Exception as exc:
            fail_streak += 1
            if fail_streak == 1 or fail_streak % 20 == 0:
                log.warning(f"[camera] get_img_compressed failed (streak={fail_streak}): {exc}")
            if fail_streak >= RECONNECT_AFTER_STREAK and (time.time() - last_reconnect_ts) > RECONNECT_COOLDOWN_S:
                last_reconnect_ts = time.time()
                if reconnect_robot_socket(reason=f"camera streak={fail_streak}"):
                    fail_streak = 0  # give the fresh socket a clean slate
            time.sleep(0.1)


def start_camera_thread() -> None:
    """Start the camera grabber once the robot is connected. Idempotent."""
    if any(t.name == "camera-grabber" for t in threading.enumerate()):
        return
    threading.Thread(target=_camera_loop, daemon=True, name="camera-grabber").start()


def get_camera_frame_bgr() -> Optional[Tuple[np.ndarray, int]]:
    """Snapshot of the latest decoded frame for AI pipelines. Returns
    (frame_copy, frame_count) or None if no frame yet."""
    with _camera_lock:
        if _camera_frame_bgr is None:
            return None
        return _camera_frame_bgr.copy(), _camera_frame_count


# ═══════════════════════════════════════════════════════════════════════════════
# STREAM HTTP API  (:5001)  — same contract as the retired niryo_stream.py
# ═══════════════════════════════════════════════════════════════════════════════

@stream_app.route("/stream")
def _stream_route():
    boundary = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
    def _gen():
        last_count = -1
        while True:
            with _camera_lock:
                jpeg  = _camera_jpeg_bytes
                count = _camera_frame_count
            if jpeg is not None and count != last_count:
                last_count = count
                yield boundary + jpeg + b"\r\n"
            time.sleep(1.0 / 30.0)
    return Response(_gen(), mimetype="multipart/x-mixed-replace; boundary=frame")


@stream_app.route("/health", methods=["GET"])
def _stream_health():
    with _state_lock:
        ok = _robot_ok and _robot is not None
    with _camera_lock:
        have_frame = _camera_frame_bgr is not None
        count      = _camera_frame_count
    return jsonify({
        "status":           "ok" if (ok and have_frame) else "degraded",
        "robot_connected":  ok,
        "frames_delivered": count,
    })


@stream_app.route("/robot-health", methods=["GET"])
def _stream_robot_health():
    with _state_lock:
        ok = _robot_ok and _robot is not None
    return jsonify({"robot_connected": ok})


@stream_app.route("/camera/pause", methods=["POST"])
def _stream_camera_pause():
    global _camera_paused
    _camera_paused = True
    return jsonify({"paused": True})


@stream_app.route("/camera/resume", methods=["POST"])
def _stream_camera_resume():
    global _camera_paused
    _camera_paused = False
    return jsonify({"paused": False})


def _start_stream_http_server() -> None:
    log.info(f"Stream HTTP service starting on http://0.0.0.0:{STREAM_SERVICE_PORT}")
    stream_app.run(host="0.0.0.0", port=STREAM_SERVICE_PORT, threaded=True)
