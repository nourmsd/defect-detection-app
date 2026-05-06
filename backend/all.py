"""
Yogurt Inspection & Pick-Place System — Combined
=================================================

Architecture overview
---------------------

  niryo_stream (:5001/stream)
       │ MJPEG
       ▼
  FrameGrabber (background thread)
       │ latest frame
       ▼
  State machine  ──SCANNING──► YOLO presence gate (PRESENCE_FRAMES stable frames)
       │                              │ snapshot frozen
       │                             ▼
       │                   processing_thread
       │                   ├─ Pipeline A: YOLO → TrOCR  (flavor text)
       │                   └─ Pipeline B: YOLO → ResNet  (expiry date, 5-shot vote)
       │                              │
       │                   build_display()
       │                   ├─ left : live frame + bboxes + state overlay
       │                   └─ right: AI diagnostics panel
       │                              │
       ├─ cv2.imshow (local debug)    │
       └─ Flask MJPEG /ai_stream (:5003)
              │ stdout SOCKET_EVENT JSON
              ▼
  Node.js backend (:5000)
       │ POST /inspection-result
       ▼
  Robot HTTP service (:5002)  ← THIS FILE also serves this endpoint
       │ pyniryo2
       ▼
  Niryo robot arm
  READING [pick] → PATH_POINT → ABOVE_BIN [release] → PATH_POINT → READING

Hardware configuration:
  Robot Software Version : 4.1.0
  Niryo Studio           : 4.1.2
  Stepper firmware:
    joint_1: 1.0.30   joint_2: 1.0.30   joint_3: 1.0.30
    joint_4: 46       joint_5: 46       joint_6: 49
  End Effector : 1.0.10
  Tool         : 46  (Large Gripper)

Services exposed by this process:
  :5002  HTTP — /inspection-result, /status, /health, /calibrate,
                /emergency-stop, /freemotion/enable|disable,
                /current-joints, /reboot-tool, /reboot-motors
  :5003  HTTP — /ai_stream  (annotated MJPEG)
               /health

Usage:
  1. Set ROBOT_IP and joint constants below (jog in Niryo Studio, copy radian values).
  2. Ensure niryo_stream is running on :5001.
  3. Run:  python all.py
"""

# ═══════════════════════════════════════════════════════════════════════════════
# IMPORTS
# ═══════════════════════════════════════════════════════════════════════════════

import os
import pathlib
import time
import threading
import json
import queue as queue_module
import uuid
import urllib.request
import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torchvision import models
from ultralytics import YOLO
from transformers import TrOCRProcessor, VisionEncoderDecoderModel
from flask import Flask, Response, jsonify, request
from flask_cors import CORS


# ═══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("yogurt-system")
logging.getLogger("werkzeug").setLevel(logging.ERROR)


# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

# ── Stream URLs ───────────────────────────────────────────────────────────────
NIRYO_STREAM_URL  = os.environ.get("NIRYO_STREAM_URL",  "http://127.0.0.1:5001/stream")
NIRYO_HEALTH_URL  = os.environ.get("NIRYO_HEALTH_URL",  "http://127.0.0.1:5001/health")
AI_STREAM_PORT    = int(os.environ.get("AI_STREAM_PORT", "5003"))

# ── Robot HTTP service ────────────────────────────────────────────────────────
ROBOT_IP           = os.environ.get("ROBOT_IP", "10.10.10.10")
ROBOT_SERVICE_PORT = int(os.environ.get("ROBOT_SERVICE_PORT", "5002"))
BACKEND_URL        = os.environ.get("BACKEND_URL", "http://127.0.0.1:5000")
STREAM_SERVICE_URL = os.environ.get("STREAM_SERVICE_URL", "http://127.0.0.1:5001")

# ── Pipeline event bus ────────────────────────────────────────────────────────
PIPELINE_EVENT_PREFIX = os.environ.get("PIPELINE_EVENT_PREFIX", "SOCKET_EVENT ")
DEVICE_NAME           = "Niryo Robot Camera"

# ── Display ───────────────────────────────────────────────────────────────────
SHOW_DEBUG_WINDOW   = True
DISPLAY_WINDOW_NAME = "Yogurt Inspection — AI Diagnostics"

# ── State machine ─────────────────────────────────────────────────────────────
PRESENCE_FRAMES   = 15    # consecutive YOLO-detected frames before snapshot
RESULT_HOLD_SECS  = 4.0   # seconds to hold RESULT state before resetting
MAX_SCAN_ATTEMPTS = 3     # failed scans with no valid date before forcing DEFECTIVE

# ── Robot watchdog ────────────────────────────────────────────────────────────
ROBOT_CHECK_INTERVAL_S = 5.0
ROBOT_WAIT_TIMEOUT_S   = 30.0   # fail fast — 30s max wait in industrial real-time context
ROBOT_RETRY_WAIT_S     = 2.0    # retry every 2s

# ── Robot motion ──────────────────────────────────────────────────────────────
CONNECT_TIMEOUT_S  = 10
MOVE_SPEED         = 25    # joint speed percentage (1–100)
GRIPPER_SPEED      = 400   # open/close speed (0–1000)
GRIPPER_HOLD_MS    = 600   # ms to hold after grasp
GRIPPER_RELEASE_MS = 400   # ms to hold after release
POLL_INTERVAL_S    = 0.5   # worker queue poll interval

# ── Model paths ───────────────────────────────────────────────────────────────
_AI_DIR               = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai")
YOLO_MODEL_PATH       = os.path.join(_AI_DIR, "yog_yolo26n.pt")
FLAVOR_MODEL_PATH     = os.path.join(_AI_DIR, "TrCustom")
CLASSIFIER_MODEL_PATH = os.path.join(_AI_DIR, "best_model.pt")

# ── YOLO ──────────────────────────────────────────────────────────────────────
YOLO_CONF_THRESHOLD = 0.25
YOLO_IOU_THRESHOLD  = 0.45
MAX_DETECTIONS      = 10

# ── Pipeline A — Flavor (TrOCR) ───────────────────────────────────────────────
FLAVOR_CLASS_NAME = "flavor"
FLAVOR_CONF       = 0.35
FLAVOR_SCALE      = 2.5
FLAVOR_SAVE_DIR   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fine_tuned_results")
os.makedirs(FLAVOR_SAVE_DIR, exist_ok=True)

# ── Pipeline B — Expiry date (ResNet multi-head classifier) ──────────────────
EXPIRY_CLASS_ID      = 1
CONFIDENCE_THRESHOLD = 0.45   # minimum overall_conf to trust a single run
EXPIRY_RUNS          = 3      # 3-shot vote — no valid date after 3 runs = DEFECTIVE

# ── Debug crops ───────────────────────────────────────────────────────────────
DEBUG_SAVE_CROPS    = True
DEBUG_CROP_DIR      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug_crops")
_debug_crop_counter = 0

# ── ImageNet normalisation ────────────────────────────────────────────────────
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
IMAGENET_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)
_CLAHE        = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))


# ═══════════════════════════════════════════════════════════════════════════════
# JOINT POSITIONS  (radians)
# ═══════════════════════════════════════════════════════════════════════════════

HOME_JOINTS      = [0.09,  0.61, -1.34,  0.09, -0.08,  0.08]
READING_JOINTS   = [0.16, -0.34, -0.75,  0.16, -0.57,  0.09]
GRAPPING_POSITION = [0.09, -0.66, -0.37, 0.15, -0.61, 0.07]
PATH_JOINTS      = [1.12,  0.03, -0.75, -0.14, -0.29,  0.19]
ABOVE_BIN_JOINTS = [1.74, -0.52, -0.06, -0.13, -0.74,  0.19]


# ═══════════════════════════════════════════════════════════════════════════════
# SHARED FLASK APPLICATIONS
# ═══════════════════════════════════════════════════════════════════════════════

ai_app    = Flask("ai_stream_server")
robot_app = Flask("robot_service")
CORS(ai_app)
CORS(robot_app)


# ═══════════════════════════════════════════════════════════════════════════════
# FRAME GRABBER
# ═══════════════════════════════════════════════════════════════════════════════

class FrameGrabber(threading.Thread):
    """Background thread: always keeps the latest frame from an MJPEG URL."""

    def __init__(self, url: str) -> None:
        super().__init__(daemon=True, name="frame-grabber")
        self._url   = url
        self._lock  = threading.Lock()
        self._frame: Optional[np.ndarray] = None
        self._count = 0
        self._alive = True

    def run(self) -> None:
        backoff = 1.0
        while self._alive:
            cap = None
            try:
                cap = cv2.VideoCapture(self._url)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                if not cap.isOpened():
                    raise RuntimeError(f"Cannot open: {self._url}")
                log.info(f"[grabber] connected → {self._url}")
                backoff = 1.0
                while self._alive:
                    ok, frame = cap.read()
                    if not ok or frame is None or frame.size == 0:
                        log.warning("[grabber] bad frame — reconnecting")
                        break
                    with self._lock:
                        self._frame  = frame
                        self._count += 1
            except Exception as exc:
                log.warning(f"[grabber] {exc} — retry in {backoff:.0f}s")
            finally:
                if cap is not None:
                    cap.release()
            if self._alive:
                time.sleep(backoff)
                backoff = min(backoff * 2, 10.0)

    def get_latest(self) -> Optional[Tuple[np.ndarray, int]]:
        with self._lock:
            if self._frame is None:
                return None
            return self._frame.copy(), self._count

    def stop(self) -> None:
        self._alive = False


# ═══════════════════════════════════════════════════════════════════════════════
# AI MJPEG STREAM  (:5003/ai_stream)
# ═══════════════════════════════════════════════════════════════════════════════

_ai_frame_lock    = threading.Lock()
_ai_latest_frame: Optional[bytes] = None


@ai_app.route("/ai_stream")
def _ai_stream_route():
    def _generate():
        while True:
            with _ai_frame_lock:
                data = _ai_latest_frame
            if data is not None:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + data + b"\r\n")
            time.sleep(1.0 / 30.0)
    return Response(_generate(), mimetype="multipart/x-mixed-replace; boundary=frame")


@ai_app.route("/health")
def _ai_health_route():
    return jsonify({"status": "ok", "stream": f"http://0.0.0.0:{AI_STREAM_PORT}/ai_stream"})


def _publish_mjpeg(vis_frame: np.ndarray) -> None:
    global _ai_latest_frame
    try:
        _, buf = cv2.imencode(".jpg", vis_frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        with _ai_frame_lock:
            _ai_latest_frame = buf.tobytes()
    except Exception:
        pass


def _start_ai_stream_server() -> None:
    ai_app.run(host="0.0.0.0", port=AI_STREAM_PORT, threaded=True)


# ═══════════════════════════════════════════════════════════════════════════════
# ROBOT STATE
# ═══════════════════════════════════════════════════════════════════════════════

_state_lock           = threading.Lock()
_robot                = None
_robot_ok             = False
_robot_busy           = False
_last_action          = "idle"
_action_queue         = queue_module.Queue(maxsize=20)
_freemotion_active    = False
_recovery_in_progress = False
_robot_session_mode   = "standby"


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
        with urllib.request.urlopen(req, timeout=3) as resp:
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
        if session_mode == "standby" and _stream_robot_connected():
            return need_calib, {"session_mode": "standby"}, alerts
        alerts.append({"level": "error", "code": "robot_not_ready", "message": "Robot not ready"})
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

        arm = getattr(robot, "arm", robot)

        # ── Improved Calibration ─────────────────────────────────────
        log.info("Checking if calibration is needed...")
        try:
            need_calib = bool(_call_first_available(arm, ["need_calibration", "calibration_needed"], default=False))
            log.info(f"Need calibration: {need_calib}")
        except:
            need_calib = True

        if need_calib:
            log.info("Starting AUTO CALIBRATION...")
            for method in ["calibrate_auto", "calibrate", "auto_calibrate"]:
                fn = getattr(arm, method, None)
                if callable(fn):
                    log.info(f"Executing {method}() ...")
                    fn()
                    log.info(f"✅ {method} completed")
                    time.sleep(3.0)   # Wait for calibration to finish
                    break
        else:
            log.info("Robot reports it is already calibrated.")

        _call_first_available(arm, ["set_arm_max_velocity", "set_max_velocity"], MOVE_SPEED)

        # Tool
        tool = getattr(robot, "tool", None)
        if tool is not None:
            try:
                _call_first_available(tool, ["update_tool", "refresh_tool"])
            except:
                pass

        with _state_lock:
            _robot, _robot_ok, _robot_session_mode = robot, True, "active"

        # Positioning
        safe_move(HOME_JOINTS, label="HOME")
        safe_move(READING_JOINTS, label="READING")
        close_gripper()
        log.info("✅ Robot fully ready at READING position")

    except Exception as exc:
        log.error(f"Robot connection failed: {exc}", exc_info=True)
        with _state_lock:
            _robot, _robot_ok = None, False
            _robot_session_mode = "standby"
        raise

def release_robot_connection(reason: str = "standby") -> None:
    global _robot, _robot_ok, _freemotion_active, _robot_session_mode
    with _state_lock:
        robot = _robot
        _robot, _robot_ok, _freemotion_active, _robot_session_mode = None, False, False, "standby"
    if robot is not None:
        try:
            close_fn = getattr(robot, "close_connection", None)
            if callable(close_fn):
                close_fn()
                log.info(f"Released robot connection — {reason}")
        except Exception as exc:
            log.warning(f"Robot disconnect warning: {exc}")


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

def safe_move(joints: list, label: str = "?") -> None:
    log.info(f"→ Moving to {label}: {[round(j, 3) for j in joints]}")
    _call_first_available(getattr(_robot, "arm", _robot), ["move_joints"], joints)
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


# ═══════════════════════════════════════════════════════════════════════════════
# PICK & PLACE — Updated with GRAPPING_POSITION
# ═══════════════════════════════════════════════════════════════════════════════

def execute_pick_and_place(item_id: str, confidence: float) -> None:
    """
    Pick defective item using GRAPPING_POSITION.
    Sequence:
    READING → open → GRAPPING_POSITION → close → PATH → ABOVE_BIN → open → close → PATH → READING
    """
    global _robot_busy, _last_action

    log.info(f"━━━ START PICK & PLACE | Item={item_id} | Conf={confidence:.1%} ━━━")

    if not ensure_robot_ready():
        log.error(f"Robot not ready after recovery - skipping {item_id}")
        _notify_backend_action(item_id, "pick_error", "robot_not_ready_after_recovery")
        return

    with _state_lock:
        _robot_busy = True
        _last_action = f"picking defective {item_id}"

    try:
        # Safety stabilization after recovery
        time.sleep(1.0)
        safe_move(READING_JOINTS, label="READING (pre-pick)")

        # === Pick sequence ===
        open_gripper()
        time.sleep(0.4)

        safe_move(GRAPPING_POSITION, label="GRAPPING_POSITION")
        time.sleep(0.3)

        close_gripper()
        time.sleep(GRIPPER_HOLD_MS / 1000.0)
        log.info("Item grasped at GRAPPING_POSITION ✔")

        # === Move to rejection bin ===
        safe_move(PATH_JOINTS, label="PATH_POINT")
        safe_move(ABOVE_BIN_JOINTS, label="ABOVE_REJECTION_BIN")

        # === Release ===
        open_gripper()
        time.sleep(GRIPPER_RELEASE_MS / 1000.0)
        log.info("Item released in rejection bin ✔")

        close_gripper()          # Reset gripper state
        time.sleep(0.3)

        # === Return to home position ===
        safe_move(PATH_JOINTS, label="PATH_POINT (return)")
        safe_move(READING_JOINTS, label="READING (return)")

        log.info(f"━━━ PICK & PLACE SUCCESS for {item_id} ━━━")
        _notify_backend_action(item_id, "pick_complete")

    except Exception as exc:
        log.error(f"Pick & place FAILED for {item_id}: {exc}", exc_info=True)
        _notify_backend_action(item_id, "pick_error", str(exc))
        try:
            open_gripper()
            safe_move(READING_JOINTS, label="READING (emergency return)")
        except Exception as rec_exc:
            log.error(f"Emergency recovery failed: {rec_exc}")
    finally:
        with _state_lock:
            _robot_busy = False
            _last_action = "idle"


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


def post_result_to_backend(
    final_class:     str,
    overall_conf:    float,
    detected_date:   Optional[str],
    flavor_text:     Optional[str],
    processing_time: float,
) -> None:
    payload = {
        "id":              str(uuid.uuid4()),
        "label":           "OK" if final_class == "NORMAL" else "defective",
        "confidence":      round(float(overall_conf), 4),
        "processing_time": round(float(processing_time), 4),
        "detected_date":   detected_date or "missing",
        "flavor":          flavor_text    or "missing",
        "device":          DEVICE_NAME,
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
# PIPELINE A — FLAVOR  (YOLO → TrOCR)
# ═══════════════════════════════════════════════════════════════════════════════

class TrOCRReader:
    def __init__(self, model_path: str) -> None:
        self.device    = "cuda" if torch.cuda.is_available() else "cpu"
        log.info(f"[FLAVOR] Loading TrOCR from '{model_path}' on {self.device} …")
        self.processor = TrOCRProcessor.from_pretrained(model_path)
        self.model     = VisionEncoderDecoderModel.from_pretrained(model_path).to(self.device)
        self.model.eval()

    def read(self, bgr_crop: np.ndarray) -> str:
        pil = Image.fromarray(cv2.cvtColor(bgr_crop, cv2.COLOR_BGR2RGB))
        px  = self.processor(images=pil, return_tensors="pt").pixel_values.to(self.device)
        with torch.no_grad():
            ids = self.model.generate(px)
        return self.processor.batch_decode(ids, skip_special_tokens=True)[0]


def run_flavor_pipeline(
    frame: np.ndarray,
    yolo:  YOLO,
    ocr:   TrOCRReader,
) -> Tuple[Optional[str], Optional[Tuple[int, int, int, int]]]:
    results     = yolo(frame, verbose=False, conf=FLAVOR_CONF)[0]
    flavor_text: Optional[str]                    = None
    flavor_bbox: Optional[Tuple[int,int,int,int]] = None
    for box in results.boxes:
        if yolo.names[int(box.cls)] != FLAVOR_CLASS_NAME: continue
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        yolo_conf       = float(box.conf[0])
        h, w            = frame.shape[:2]
        crop = frame[max(0,y1-5):min(h,y2+5), max(0,x1-15):min(w,x2+15)]
        if crop.size == 0: continue
        crop_up     = cv2.resize(crop, None, fx=FLAVOR_SCALE, fy=FLAVOR_SCALE,
                                 interpolation=cv2.INTER_LANCZOS4)
        flavor_text = ocr.read(crop_up).strip()
        flavor_bbox = (x1, y1, x2, y2)
        log.info(f"[FLAVOR] YOLO={yolo_conf:.2f} | TrOCR → '{flavor_text}'")
        ts        = datetime.now().strftime("%H%M%S_%f")
        safe_name = "".join(c for c in flavor_text if c.isalnum()) or "unknown"
        cv2.imwrite(f"{FLAVOR_SAVE_DIR}/{safe_name}_{ts}.jpg", crop)
        break
    return flavor_text, flavor_bbox


# ═══════════════════════════════════════════════════════════════════════════════
# PIPELINE B — EXPIRY DATE  (YOLO → ResNet multi-head classifier)
# ═══════════════════════════════════════════════════════════════════════════════

class MultiHeadExpiryModel(nn.Module):
    def __init__(self, backbone_name: str = "resnet18", pretrained: bool = False,
                 dropout: float = 0.20) -> None:
        super().__init__()
        self.backbone_name = backbone_name
        if backbone_name == "resnet18":
            weights     = models.ResNet18_Weights.DEFAULT if pretrained else None
            backbone    = models.resnet18(weights=weights)
            feature_dim = backbone.fc.in_features
            backbone.fc = nn.Identity()
        elif backbone_name == "mobilenet_v2":
            weights     = models.MobileNet_V2_Weights.DEFAULT if pretrained else None
            backbone    = models.mobilenet_v2(weights=weights)
            feature_dim = backbone.classifier[1].in_features
            backbone.classifier = nn.Identity()
        else:
            raise ValueError("backbone_name must be 'resnet18' or 'mobilenet_v2'")
        self.backbone       = backbone
        self.dropout        = nn.Dropout(dropout)
        self.defect_head    = nn.Linear(feature_dim, 2)
        self.day_tens_head  = nn.Linear(feature_dim, 4)
        self.day_units_head = nn.Linear(feature_dim, 10)
        self.month_head     = nn.Linear(feature_dim, 12)

    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        feat = self.backbone(x)
        if feat.ndim > 2: feat = torch.flatten(feat, 1)
        feat = self.dropout(feat)
        return {
            "is_defect":  self.defect_head(feat),
            "day_tens":   self.day_tens_head(feat),
            "day_units":  self.day_units_head(feat),
            "month":      self.month_head(feat),
        }


def load_expiry_models(device: torch.device) -> Tuple[nn.Module, Dict]:
    ckpt_path = Path(CLASSIFIER_MODEL_PATH).resolve()
    torch.serialization.add_safe_globals([pathlib.WindowsPath])
    ckpt  = torch.load(ckpt_path, map_location=device, weights_only=False)
    model = MultiHeadExpiryModel(
        backbone_name=ckpt.get("backbone", "resnet18"), pretrained=False
    )
    model.load_state_dict(ckpt["model_state_dict"], strict=True)
    model.to(device).eval()
    meta = {
        "image_size":               tuple(ckpt.get("image_size", [128, 40])),
        "idx_to_month":             {int(k): v for k, v in ckpt.get("idx_to_month", {}).items()},
        "normalize_for_pretrained": bool(ckpt.get("normalize_for_pretrained", True)),
    }
    log.info(f"[EXPIRY] Classifier loaded from '{ckpt_path}' on {device}")
    return model, meta


def _preprocess_crop(crop: np.ndarray, meta: Dict, device: torch.device) -> torch.Tensor:
    global _debug_crop_counter
    if DEBUG_SAVE_CROPS and _debug_crop_counter < 200:
        os.makedirs(DEBUG_CROP_DIR, exist_ok=True)
        cv2.imwrite(os.path.join(DEBUG_CROP_DIR, f"{_debug_crop_counter:04d}_raw.jpg"), crop)
        _debug_crop_counter += 1
    w, h   = meta["image_size"]
    gray   = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    interp = cv2.INTER_CUBIC if gray.shape[1] < w else cv2.INTER_AREA
    gray   = cv2.resize(gray, (w, h), interpolation=interp)
    gray   = _CLAHE.apply(gray)
    gray   = gray.astype(np.float32) / 255.0
    img    = np.stack([gray, gray, gray], axis=0)
    if meta["normalize_for_pretrained"]:
        img = (img - IMAGENET_MEAN) / IMAGENET_STD
    return torch.from_numpy(np.ascontiguousarray(img)).unsqueeze(0).to(device, non_blocking=True)


def _classify_crop(model: nn.Module, crop: np.ndarray, meta: Dict, device: torch.device) -> Dict:
    tensor = _preprocess_crop(crop, meta, device)
    with torch.no_grad():
        out   = model(tensor)
        probs = {k: torch.softmax(v, dim=1) for k, v in out.items()}
    defect_idx  = int(probs["is_defect"].argmax(dim=1))
    defect_conf = float(probs["is_defect"].max(dim=1).values)
    day_tens    = int(probs["day_tens"].argmax(dim=1))
    day_units   = int(probs["day_units"].argmax(dim=1))
    month_idx   = int(probs["month"].argmax(dim=1))
    dt_conf     = float(probs["day_tens"].max(dim=1).values)
    du_conf     = float(probs["day_units"].max(dim=1).values)
    mo_conf     = float(probs["month"].max(dim=1).values)
    final_day   = day_tens * 10 + day_units
    final_month = meta["idx_to_month"].get(month_idx, str(month_idx))
    day_conf    = 0.5 * (dt_conf + du_conf)
    overall     = 0.5 * (day_conf + mo_conf)
    return {
        "text": f"{final_day:02d} {final_month}", "day": final_day, "month": final_month,
        "day_conf": day_conf, "month_conf": mo_conf, "overall_conf": overall,
        "model_says_defect": defect_idx == 1, "defect_conf": defect_conf,
        "head_conf": {"day_tens": dt_conf, "day_units": du_conf, "month": mo_conf},
    }


def run_expiry_pipeline(
    snapshot:   np.ndarray,
    yolo:       YOLO,
    classifier: nn.Module,
    meta:       Dict,
    device:     torch.device,
) -> List[Dict]:
    """
    YOLO finds expiry crops → 5-shot majority vote through ResNet classifier.
    Zero confident date reads after all 5 runs → DEFECTIVE.
    """
    results: List[Dict] = []
    yolo_res = yolo.predict(
        source=snapshot, conf=YOLO_CONF_THRESHOLD,
        iou=YOLO_IOU_THRESHOLD, max_det=MAX_DETECTIONS, verbose=False,
    )
    if not yolo_res or yolo_res[0].boxes is None:
        return results

    for raw_box, yolo_conf, cls in zip(
        yolo_res[0].boxes.xyxy.cpu().numpy(),
        yolo_res[0].boxes.conf.cpu().numpy(),
        yolo_res[0].boxes.cls.cpu().numpy().astype(int),
    ):
        if cls != EXPIRY_CLASS_ID: continue
        x1, y1, x2, y2 = raw_box.astype(int).tolist()
        pad = 10
        cx1 = max(0, x1 - pad);  cy1 = max(0, y1 - pad)
        cx2 = min(snapshot.shape[1] - 1, x2 + pad)
        cy2 = min(snapshot.shape[0] - 1, y2 + pad)
        crop = snapshot[cy1:cy2, cx1:cx2]
        if crop.size == 0: continue

        votes:        List[str] = []
        defect_votes: int       = 0
        last_c:       Dict      = {}

        for run_i in range(EXPIRY_RUNS):
            c      = _classify_crop(classifier, crop, meta, device)
            last_c = c
            log.info(
                f"[EXPIRY] YOLO={float(yolo_conf):.2f} | "
                f"run={run_i+1}/{EXPIRY_RUNS} raw='{c['text']}' "
                f"conf={c['overall_conf']:.2f} defect={c['model_says_defect']}"
            )
            if c["model_says_defect"]:
                defect_votes += 1
            elif c["overall_conf"] >= CONFIDENCE_THRESHOLD:
                votes.append(c["text"])

        if defect_votes > EXPIRY_RUNS // 2:
            # Majority of runs explicitly flagged defective by the model
            status, best_text, best_conf = "DEFECTIVE", "DEFECTIVE", 0.0
        elif votes:
            # At least one confident valid date — take the majority vote
            best_text = Counter(votes).most_common(1)[0][0]
            status    = "NORMAL"
            best_conf = len([v for v in votes if v == best_text]) / EXPIRY_RUNS
        else:
            # Zero confident date reads after all 5 runs → DEFECTIVE
            log.warning(
                f"[EXPIRY] No valid date in {EXPIRY_RUNS} classifier runs "
                f"(defect_votes={defect_votes}, conf_votes=0) — forcing DEFECTIVE"
            )
            status    = "DEFECTIVE"
            best_text = "DEFECTIVE"
            best_conf = last_c.get("defect_conf", 0.0)

        log.info(
            f"[EXPIRY] → winner='{best_text}' status={status} "
            f"({len(votes)}/{EXPIRY_RUNS} confident votes)"
        )
        results.append({
            "text": best_text, "status": status, "overall_conf": best_conf,
            "day_conf":          last_c.get("day_conf", 0.0),
            "month_conf":        last_c.get("month_conf", 0.0),
            "model_says_defect": last_c.get("model_says_defect", False),
            "defect_conf":       last_c.get("defect_conf", 0.0),
            "day":               last_c.get("day", 0),
            "month":             last_c.get("month", "?"),
            "head_conf":         last_c.get("head_conf", {}),
            "yolo_conf":         float(yolo_conf),
            "crop_bbox":         (x1, y1, x2, y2),
            "crop":              crop,
        })

    return results


# ═══════════════════════════════════════════════════════════════════════════════
# SHARED RESULT DATACLASS
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class InspectionResult:
    flavor_text:    Optional[str]                    = None
    flavor_bbox:    Optional[Tuple[int,int,int,int]] = None
    expiry_outputs: List[Dict]                       = field(default_factory=list)
    done:           bool                             = False
    t_start:        float                            = field(default_factory=time.perf_counter)


# ═══════════════════════════════════════════════════════════════════════════════
# AI DIAGNOSTICS DISPLAY
# ═══════════════════════════════════════════════════════════════════════════════

_COLOR_VALID   = (0, 220, 0)
_COLOR_DEFECT  = (0, 0, 220)
_COLOR_WARNING = (0, 165, 255)
_COLOR_FLAVOR  = (255, 200, 0)
_PANEL_W       = 340
_PANEL_BG      = (15, 20, 30)


def _conf_color(conf: float) -> Tuple[int, int, int]:
    if conf >= 0.70: return (0, 210, 80)
    if conf >= 0.40: return (0, 165, 255)
    return (60, 60, 220)


def _conf_bar(panel: np.ndarray, x: int, y: int, label: str, conf: float) -> int:
    color = _conf_color(conf)
    bar_x = x + 118;  bar_y = y - 10
    bar_w = _PANEL_W - bar_x - 38;  bar_h = 9
    cv2.putText(panel, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (180,180,180), 1, cv2.LINE_AA)
    cv2.rectangle(panel, (bar_x, bar_y), (bar_x+bar_w, bar_y+bar_h), (45,45,55), -1)
    fill = int(conf * bar_w)
    if fill > 0:
        cv2.rectangle(panel, (bar_x, bar_y), (bar_x+fill, bar_y+bar_h), color, -1)
    cv2.putText(panel, f"{int(conf*100)}%", (bar_x+bar_w+4, y),
                cv2.FONT_HERSHEY_SIMPLEX, 0.34, color, 1, cv2.LINE_AA)
    return y + 17


def build_display(
    base_frame: np.ndarray, result: InspectionResult,
    state: str, presence_frac: float, fps: float,
    scan_attempts: int = 0,
) -> np.ndarray:
    main = base_frame.copy()
    h, w = main.shape[:2];  pad = 7

    if result.flavor_bbox and result.flavor_text:
        x1, y1, x2, y2 = result.flavor_bbox
        cv2.rectangle(main, (x1,y1), (x2,y2), _COLOR_FLAVOR, 2)
        cv2.putText(main, result.flavor_text, (x1, max(20,y1-8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, _COLOR_FLAVOR, 2, cv2.LINE_AA)

    for det in result.expiry_outputs:
        x1, y1, x2, y2 = det["crop_bbox"];  status = det["status"]
        if status == "NORMAL":     color, lbl = _COLOR_VALID,   f"DATE: {det['text']}"
        elif status == "DEFECTIVE": color, lbl = _COLOR_DEFECT,  "DEFECTIVE"
        else:                       color, lbl = _COLOR_WARNING, f"? {det['text']}"
        cv2.rectangle(main, (x1,y1), (x2,y2), color, 3)
        cv2.putText(main, lbl, (x1, max(20,y1-10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2, cv2.LINE_AA)

    fps_lbl = f"FPS {fps:.1f}"
    (tw, _), _ = cv2.getTextSize(fps_lbl, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2)
    cv2.putText(main, fps_lbl, (w-tw-10, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0,255,255), 2, cv2.LINE_AA)

    if state == "SCANNING":
        bar_full = int(presence_frac * (w - 20))
        cv2.rectangle(main, (10,h-18), (10+bar_full,h-8), (0,200,255), -1)
        attempts_lbl = f"  [attempt {scan_attempts}/{MAX_SCAN_ATTEMPTS}]" if scan_attempts > 0 else ""
        cv2.putText(main, f"SCANNING — hold steady ({int(presence_frac*100)}%){attempts_lbl}",
                    (10,30), cv2.FONT_HERSHEY_SIMPLEX, 0.60, (0,200,255), 2, cv2.LINE_AA)
    elif state == "PROCESSING":
        cv2.putText(main, "PROCESSING ...", (10,30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255,180,0), 2, cv2.LINE_AA)
    elif state == "RESULT":
        cv2.putText(main, "INSPECTION COMPLETE", (10,30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0,255,100), 2, cv2.LINE_AA)
        fl    = f"Flavor: {result.flavor_text}" if result.flavor_text else "Flavor: -"
        best_e = next((e for e in result.expiry_outputs if e["status"] == "NORMAL"), None)
        ex    = f"Date: {best_e['text']}" if best_e else "Date: -"
        cv2.putText(main, fl, (10,60),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, _COLOR_FLAVOR, 2, cv2.LINE_AA)
        cv2.putText(main, ex, (10,88),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, _COLOR_VALID,  2, cv2.LINE_AA)

    # ── Right diagnostics panel ────────────────────────────────────────────────
    panel = np.full((h, _PANEL_W, 3), _PANEL_BG, dtype=np.uint8)
    cv2.putText(panel, "AI DIAGNOSTICS", (pad,22),
                cv2.FONT_HERSHEY_SIMPLEX, 0.52, (0,210,210), 1, cv2.LINE_AA)
    cv2.putText(panel, f"FPS {fps:.1f}", (_PANEL_W-64,22),
                cv2.FONT_HERSHEY_SIMPLEX, 0.42, (110,110,110), 1, cv2.LINE_AA)
    cv2.putText(panel, f"STATE: {state}", (pad,40),
                cv2.FONT_HERSHEY_SIMPLEX, 0.40, (160,160,160), 1, cv2.LINE_AA)
    # Show scan attempt counter on panel
    if scan_attempts > 0:
        attempt_color = _COLOR_WARNING if scan_attempts < MAX_SCAN_ATTEMPTS else _COLOR_DEFECT
        cv2.putText(panel, f"SCAN ATTEMPT: {scan_attempts}/{MAX_SCAN_ATTEMPTS}",
                    (pad, 54), cv2.FONT_HERSHEY_SIMPLEX, 0.38, attempt_color, 1, cv2.LINE_AA)
        cv2.line(panel, (0,62), (_PANEL_W,62), (40,40,55), 1)
        py = 72
    else:
        cv2.line(panel, (0,48), (_PANEL_W,48), (40,40,55), 1)
        py = 58

    cv2.putText(panel, "FLAVOR", (pad,py),
                cv2.FONT_HERSHEY_SIMPLEX, 0.44, _COLOR_FLAVOR, 1, cv2.LINE_AA)
    py += 15
    fl_disp = result.flavor_text or "not detected"
    cv2.putText(panel, f"  {fl_disp}", (pad,py), cv2.FONT_HERSHEY_SIMPLEX, 0.46,
                _COLOR_FLAVOR if result.flavor_text else (80,80,80), 1, cv2.LINE_AA)
    py += 14
    cv2.line(panel, (pad,py+2), (_PANEL_W-pad,py+2), (38,38,52), 1);  py += 10

    if not result.expiry_outputs:
        cv2.putText(panel, "No expiry detections", (pad,py+18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.44, (90,90,90), 1, cv2.LINE_AA)

    for i, det in enumerate(result.expiry_outputs):
        if py > h - 30: break
        status            = det["status"]
        head_conf         = det.get("head_conf", {})
        day_val           = det.get("day", 0)
        month_val         = det.get("month", "?")
        defect_conf       = float(det.get("defect_conf", 0.0))
        model_says_defect = bool(det.get("model_says_defect", False))
        yolo_conf_val     = float(det.get("yolo_conf", 0.0))
        raw_date          = det.get("text", "NONE")
        overall           = float(det.get("overall_conf", 0.0))
        day_tens_conf     = float(head_conf.get("day_tens",  0.0))
        day_units_conf    = float(head_conf.get("day_units", 0.0))
        month_conf        = float(head_conf.get("month",     0.0))
        sc = (_COLOR_VALID if status=="NORMAL" else
              _COLOR_DEFECT if status=="DEFECTIVE" else _COLOR_WARNING)

        cv2.putText(panel, f"Expiry #{i+1}", (pad,py),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.40, (200,200,200), 1, cv2.LINE_AA)
        py += 15
        cv2.putText(panel, status, (pad,py),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.48, sc, 1, cv2.LINE_AA)
        cv2.putText(panel, f"YOLO {int(yolo_conf_val*100)}%", (pad+100,py),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.38, (130,130,130), 1, cv2.LINE_AA)
        py += 14

        crop = det.get("crop")
        if crop is not None and crop.size > 0:
            try:
                gray    = _CLAHE.apply(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY))
                thumb_w = _PANEL_W - 2 * pad
                thumb_h = max(32, min(90, int(thumb_w * crop.shape[0] / max(crop.shape[1], 1))))
                thumb   = cv2.cvtColor(
                    cv2.resize(gray, (thumb_w, thumb_h), interpolation=cv2.INTER_NEAREST),
                    cv2.COLOR_GRAY2BGR,
                )
                cv2.rectangle(panel, (pad-1,py-1), (pad+thumb_w,py+thumb_h), sc, 1)
                panel[py:py+thumb_h, pad:pad+thumb_w] = thumb
                cv2.putText(panel, "YOLO crop (CLAHE)", (pad,py+thumb_h+10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.28, (90,90,90), 1, cv2.LINE_AA)
                py += thumb_h + 16
            except Exception:
                py += 4

        py = _conf_bar(panel, pad, py, f"Day tens  [{day_val//10}]", day_tens_conf)
        py = _conf_bar(panel, pad, py, f"Day units [{day_val%10}]",  day_units_conf)
        cv2.putText(panel, f"  -> Day : {day_val:02d}", (pad,py), cv2.FONT_HERSHEY_SIMPLEX, 0.40,
                    _conf_color((day_tens_conf+day_units_conf)/2), 1, cv2.LINE_AA)
        py += 15
        py = _conf_bar(panel, pad, py, f"Month     [{month_val}]", month_conf)
        date_color = _COLOR_VALID if raw_date not in ("NONE","DEFECTIVE","") else (90,90,90)
        cv2.putText(panel, f"  -> Date: {raw_date}", (pad,py),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.44, date_color, 1, cv2.LINE_AA)
        py += 16
        defect_disp = defect_conf if model_says_defect else (1.0 - defect_conf)
        py = _conf_bar(panel, pad, py,
                       f"Is defect {'YES' if model_says_defect else 'NO '}", defect_disp)
        cv2.putText(panel, f"  Overall conf: {overall:.2f}", (pad,py),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.37, _conf_color(overall), 1, cv2.LINE_AA)
        py += 15
        cv2.putText(panel, f"  Votes: {EXPIRY_RUNS}-shot majority", (pad,py),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.34, (140,140,140), 1, cv2.LINE_AA)
        py += 13
        if status in ("NORMAL", "DEFECTIVE"):
            cv2.putText(panel, f"  FINAL: {raw_date}", (pad,py),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.52, sc, 2, cv2.LINE_AA)
            py += 18
        cv2.line(panel, (pad,py+2), (_PANEL_W-pad,py+2), (38,38,52), 1);  py += 10

    if panel.shape[0] != h:
        panel = cv2.resize(panel, (_PANEL_W, h))
    return np.concatenate([main, panel], axis=1)


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


@robot_app.route("/freemotion/enable", methods=["POST"])
def enable_freemotion():
    global _freemotion_active
    with _state_lock:
        if not _robot_ok or _robot is None: return jsonify({"error": "robot_not_ready"}), 503
        if _robot_busy:                      return jsonify({"error": "robot_busy"}), 409
        try:
            _robot.arm.set_learning_mode(True)
            _freemotion_active = True
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
    log.info("Free motion ENABLED")
    return jsonify({"freemotion": True})


@robot_app.route("/freemotion/disable", methods=["POST"])
def disable_freemotion():
    global _freemotion_active
    with _state_lock:
        _freemotion_active = False
        if _robot_ok and _robot is not None:
            try:   _robot.arm.set_learning_mode(False)
            except Exception as exc: return jsonify({"error": str(exc)}), 500
    log.info("Free motion DISABLED")
    return jsonify({"freemotion": False})


@robot_app.route("/current-joints", methods=["GET"])
def get_current_joints():
    with _state_lock:
        if not _robot_ok or _robot is None: return jsonify({"error": "robot_not_ready"}), 503
        try:
            joints = list(_call_first_available(getattr(_robot,"arm",_robot), ["get_joints"]))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
    log.info(f"Current joints: {[round(j,4) for j in joints]}")
    return jsonify({"joints": joints})


@robot_app.route("/reboot-tool", methods=["POST"])
def reboot_tool():
    global _last_action
    if not ensure_robot_ready(): return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        if _robot_busy: return jsonify({"message": "robot_busy"}), 409
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
        if _robot_busy: return jsonify({"message": "robot_busy"}), 409
        _last_action = "reboot_motors"
        try:
            try:   _call_first_available(_robot, ["reboot_motors"])
            except Exception:
                _call_first_available(_robot.arm,
                    ["reboot_motors","reboot_motor","reboot","reboot_arm"])
            time.sleep(1.0)
            _call_first_available(_robot, ["set_learning_mode"], False)
            _robot.arm.set_arm_max_velocity(MOVE_SPEED)
            try:
                if bool(_call_first_available(_robot, ["need_calibration"])):
                    _call_first_available(_robot, ["calibrate_auto","calibrate"])
            except Exception as diag_exc:
                log.warning(f"Post-reboot calibration check failed: {diag_exc}")
            safe_move(READING_JOINTS, label="READING (after motors reboot)")
            msg = "Motors reboot complete";  log.info(msg);  return jsonify({"message": msg})
        except Exception as exc:
            log.error(f"Motors reboot failed: {exc}");  return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@robot_app.route("/calibrate", methods=["POST"])
def calibrate_robot():
    global _robot_ok, _last_action, _freemotion_active
    if not ensure_robot_ready(): return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        if _robot is None: return jsonify({"message": "robot_not_ready"}), 503
        if _robot_busy:    return jsonify({"message": "robot_busy"}), 409
        prev_ready = _robot_ok;  _last_action = "calibrating"
        try:
            _call_first_available(_robot, ["set_learning_mode"], False)
            _freemotion_active = False
            need_calib = bool(_call_first_available(_robot, ["need_calibration"]))
            if need_calib: _call_first_available(_robot, ["calibrate_auto","calibrate"])
            else:          log.info("Calibration not required per robot diagnostics")
            _robot.arm.set_arm_max_velocity(MOVE_SPEED)
            safe_move(HOME_JOINTS,    label="HOME (after calibration)")
            safe_move(READING_JOINTS, label="READING (after calibration)")
            _robot_ok = True
            msg = "Calibration complete" if need_calib else "Calibration not required; pose reset complete"
            log.info(msg);  return jsonify({"message": msg})
        except Exception as exc:
            _robot_ok = prev_ready;  log.error(f"Calibration failed: {exc}")
            return jsonify({"message": str(exc)}), 500
        finally:
            _last_action = "idle"


@robot_app.route("/emergency-stop", methods=["POST"])
def emergency_stop():
    global _robot_busy, _last_action
    if not ensure_robot_ready(): return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        _last_action = "emergency_stop"
        try:
            _call_first_available(getattr(_robot,"arm",_robot),
                                  ["stop_move","stop","emergency_stop","halt"])
            _robot_busy = False;  msg = "Emergency stop executed"
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
            "robot_busy":        _robot_busy,
            "freemotion_active": _freemotion_active,
            "last_action":       _last_action,
            "queue_size":        _action_queue.qsize(),
            "need_calibration":  need_calib,
            "hardware_status":   hardware_status,
            "alerts":            alerts,
            "session_mode":      _robot_session_mode,
        })


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
# MAIN LOOP
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    log.info(
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        " Yogurt Inspection & Pick-Place System\n"
        f"  Robot IP            : {ROBOT_IP}\n"
        f"  Robot service port  : {ROBOT_SERVICE_PORT}\n"
        f"  AI stream port      : {AI_STREAM_PORT}\n"
        f"  YOLO model          : {YOLO_MODEL_PATH}\n"
        f"  Flavor model        : {FLAVOR_MODEL_PATH}\n"
        f"  Expiry model        : {CLASSIFIER_MODEL_PATH}\n"
        f"  Expiry runs/scan    : {EXPIRY_RUNS} (no valid date → DEFECTIVE)\n"
        f"  Max scan attempts   : {MAX_SCAN_ATTEMPTS} (then force DEFECTIVE + pick)\n"
        f"  Watchdog timeout    : {ROBOT_WAIT_TIMEOUT_S}s\n"
        f"  Move speed          : {MOVE_SPEED}%\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    )

    log.info("[INIT] Loading shared YOLO model …")
    yolo = YOLO(YOLO_MODEL_PATH)

    log.info("[INIT] Loading Pipeline A — TrOCR flavor reader …")
    ocr_reader = TrOCRReader(FLAVOR_MODEL_PATH)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    log.info(f"[INIT] Loading Pipeline B — expiry classifier on {device} …")
    classifier, expiry_meta = load_expiry_models(device)

    threading.Thread(target=_start_ai_stream_server,  daemon=True, name="ai-stream").start()
    threading.Thread(target=_start_robot_http_server, daemon=True, name="robot-http").start()
    threading.Thread(target=worker_loop,              daemon=True, name="robot-worker").start()
    log.info(f"[INIT] AI stream  → http://0.0.0.0:{AI_STREAM_PORT}/ai_stream")
    log.info(f"[INIT] Robot API  → http://0.0.0.0:{ROBOT_SERVICE_PORT}")

    def _robot_init_loop():
        backoff = 5;  attempt = 0
        while True:
            attempt += 1
            try:
                connect_robot()
                log.info(f"✔ Robot connected after {attempt} attempt(s) — watchdog warnings will stop.")
                _emit_pipeline_state("RUNNING", "Robot connected — AI pipeline fully active")
                break
            except Exception as exc:
                log.warning(f"[robot-init] Attempt {attempt} failed: {exc} — retry in {backoff}s")
                time.sleep(backoff)
                backoff = min(backoff * 2, 10)

    threading.Thread(target=_robot_init_loop, daemon=True, name="robot-init").start()

    log.info(f"[INIT] Waiting for niryo_stream at {NIRYO_HEALTH_URL} ...")
    t_wait = time.perf_counter()
    while not _check_stream_reachable():
        if time.perf_counter() - t_wait > ROBOT_WAIT_TIMEOUT_S:
            log.error(f"[INIT] niryo_stream not reachable after {ROBOT_WAIT_TIMEOUT_S:.0f}s -- exiting.")
            _emit_pipeline_state("IDLE", "niryo_stream unreachable -- AI pipeline paused")
            return
        log.info(f"[INIT] niryo_stream not yet up -- retrying in {ROBOT_RETRY_WAIT_S:.0f}s ...")
        _emit_pipeline_state("IDLE", "Waiting for niryo_stream ...")
        time.sleep(ROBOT_RETRY_WAIT_S)

    log.info("[INIT] niryo_stream is up -- starting frame acquisition ...")
    if _check_robot_connected_via_health():
        log.info("[INIT] Robot already connected.")
        _emit_pipeline_state("RUNNING", "Robot connected -- AI pipeline active")
    else:
        log.warning("[INIT] niryo_stream up but robot not yet connected -- watchdog will monitor.")
        _emit_pipeline_state("RUNNING", "Stream up -- waiting for robot connection")

    grabber = FrameGrabber(NIRYO_STREAM_URL)
    grabber.start()
    t0 = time.perf_counter()
    while grabber.get_latest() is None:
        if time.perf_counter() - t0 > 15.0:
            raise RuntimeError("No frame from niryo_stream within 15s — is it running?")
        time.sleep(0.1)
    log.info("[INIT] First frame received — state machine starting.")

    # ── State machine variables ───────────────────────────────────────────────
    state:           str              = "SCANNING"
    presence_frames: int              = 0
    has_scanned:     bool             = False
    show_timer:      float            = 0.0
    shared_result:   InspectionResult = InspectionResult()
    result_lock:     threading.Lock   = threading.Lock()
    prev_fc:         int              = -1
    prev_tick:       float            = time.perf_counter()
    fps:             float            = 0.0
    t_snap_start:    float            = 0.0
    last_robot_chk:  float            = time.perf_counter()

    # ── Scan attempt counter ──────────────────────────────────────────────────
    # Tracks how many consecutive full inspection cycles on the SAME product
    # returned no valid date. After MAX_SCAN_ATTEMPTS → force DEFECTIVE + pick.
    scan_attempts: int = 0

    def processing_thread(snap: np.ndarray) -> None:
        nonlocal shared_result
        ta = time.perf_counter()
        flavor_text, flavor_bbox = run_flavor_pipeline(snap, yolo, ocr_reader)
        log.info(f"[FLAVOR] {int((time.perf_counter()-ta)*1000)} ms → '{flavor_text}'")
        tb = time.perf_counter()
        expiry_outs = run_expiry_pipeline(snap, yolo, classifier, expiry_meta, device)
        log.info(f"[EXPIRY] {int((time.perf_counter()-tb)*1000)} ms → {len(expiry_outs)} result(s)")

        best = next(
            (e for e in expiry_outs if e["status"] == "NORMAL"),
            expiry_outs[0] if expiry_outs else None,
        )
        if best:
            threading.Thread(
                target=post_result_to_backend,
                args=(
                    best["status"],         # NORMAL or DEFECTIVE only
                    best["overall_conf"],
                    best["text"] if best["status"] == "NORMAL" else None,
                    flavor_text,
                    time.perf_counter() - t_snap_start,
                ),
                daemon=True,
            ).start()

        with result_lock:
            shared_result.flavor_text    = flavor_text
            shared_result.flavor_bbox    = flavor_bbox
            shared_result.expiry_outputs = expiry_outs
            shared_result.done           = True

    # ── Main loop ─────────────────────────────────────────────────────────────
    try:
        while True:

            # Watchdog — only log once per state change, not every 5s
            now = time.perf_counter()
            if now - last_robot_chk >= ROBOT_CHECK_INTERVAL_S:
                last_robot_chk = now
                if not _check_stream_reachable():
                    log.warning("[watchdog] niryo_stream unreachable -- stopping pipeline.")
                    _emit_pipeline_state("PAUSED", "niryo_stream lost -- AI pipeline paused")
                    break
                if not _check_robot_connected_via_health() and not _robot_ok:
                    log.warning("[watchdog] Robot not yet connected -- continuing to stream.")
                    _emit_pipeline_state("RUNNING", "Stream up -- robot connecting ...")

            latest = grabber.get_latest()
            if latest is None: time.sleep(0.02); continue
            frame, fc = latest
            if fc == prev_fc: time.sleep(0.01); continue
            prev_fc   = fc
            now       = time.perf_counter()
            fps       = 1.0 / max(now - prev_tick, 1e-6)
            prev_tick = now

            # ── SCANNING ──────────────────────────────────────────────────────
            if state == "SCANNING":
                chk      = yolo(frame, verbose=False, conf=YOLO_CONF_THRESHOLD)[0]
                detected = len(chk.boxes) > 0
                if detected and not has_scanned: presence_frames += 1
                elif not detected:
                    presence_frames = 0
                    has_scanned     = False
                frac = min(presence_frames / PRESENCE_FRAMES, 1.0)
                if presence_frames >= PRESENCE_FRAMES and not has_scanned:
                    has_scanned   = True;  state = "PROCESSING"
                    t_snap_start  = time.perf_counter()
                    snap          = frame.copy()
                    shared_result = InspectionResult(t_start=t_snap_start)
                    threading.Thread(target=processing_thread, args=(snap,), daemon=True).start()
                display = build_display(frame, shared_result, state, frac, fps, scan_attempts)

            # ── PROCESSING ────────────────────────────────────────────────────
            elif state == "PROCESSING":
                with result_lock: done = shared_result.done
                if done: state = "RESULT";  show_timer = time.time()
                display = build_display(frame, shared_result, state, 1.0, fps, scan_attempts)

            # ── RESULT ────────────────────────────────────────────────────────
            elif state == "RESULT":
                display = build_display(frame, shared_result, state, 1.0, fps, scan_attempts)

                if time.time() - show_timer > RESULT_HOLD_SECS:

                    has_valid_date = any(
                        e["status"] == "NORMAL" for e in shared_result.expiry_outputs
                    )

                    if has_valid_date:
                        # Valid date found — reset counter, product is OK
                        if scan_attempts > 0:
                            log.info(f"[state] Valid date found after {scan_attempts} attempt(s) "
                                     f"— resetting scan counter.")
                        scan_attempts = 0

                    else:
                        # No valid date this scan — increment counter
                        scan_attempts += 1
                        log.warning(
                            f"[state] No valid date on scan attempt "
                            f"{scan_attempts}/{MAX_SCAN_ATTEMPTS}."
                        )

                        if scan_attempts >= MAX_SCAN_ATTEMPTS:
                            # ── FORCE DEFECTIVE after MAX_SCAN_ATTEMPTS failed scans ──
                            log.warning(
                                f"[state] {MAX_SCAN_ATTEMPTS} consecutive scans with no valid date "
                                f"— forcing DEFECTIVE and queuing for pick-and-place."
                            )
                            forced_id   = str(uuid.uuid4())
                            forced_conf = 0.0

                            # Notify Node.js event bus
                            post_result_to_backend(
                                "DEFECTIVE", forced_conf, None,
                                shared_result.flavor_text, 0.0,
                            )

                            # Queue robot pick-and-place
                            try:
                                _action_queue.put_nowait({
                                    "id":         forced_id,
                                    "confidence": forced_conf,
                                })
                                log.info(
                                    f"[state] Forced DEFECTIVE item {forced_id} queued "
                                    f"(queue size: {_action_queue.qsize()})."
                                )
                            except queue_module.Full:
                                log.warning("[state] Action queue full — forced DEFECTIVE dropped.")

                            # Reset counter for the next product
                            scan_attempts = 0

                    state           = "SCANNING"
                    presence_frames = 0
                    has_scanned     = False
                    shared_result   = InspectionResult()

            _publish_mjpeg(display)
            if SHOW_DEBUG_WINDOW:
                cv2.imshow(DISPLAY_WINDOW_NAME, display)
                if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                    break

    finally:
        grabber.stop()
        cv2.destroyAllWindows()


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    main()
