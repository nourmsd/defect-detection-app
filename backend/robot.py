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
    ROBOT_ROSBRIDGE_PORT, ROBOT_DEFECTIVE_PROGRAM, ROBOT_DEFECTIVE_PROGRAM_LANGUAGE,
    _plc_client, _SNAP7_AVAILABLE, plc_heartbeat,
)
import os
robot_app = Flask("robot_service")
CORS(robot_app)
stream_app = Flask("stream_service")
CORS(stream_app)
_state_lock           = threading.Lock()
_pyniryo_lock         = threading.RLock()
_robot                = None
_robot_ok             = False
_last_action          = "idle"
_action_queue         = queue_module.Queue(maxsize=20)
_recovery_in_progress = False
_robot_session_mode   = "standby"
_reference_date_lock: threading.Lock      = threading.Lock()
_reference_date:      Optional[str]       = os.environ.get("REFERENCE_DATE") or None
_camera_lock         = threading.Lock()
_camera_jpeg_bytes:  Optional[bytes]      = None   
_camera_frame_bgr:   Optional[np.ndarray] = None   
_camera_frame_count: int                  = 0
_camera_paused                            = False
STREAM_SERVICE_PORT  = 5001 
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
        return need_calib, hardware_status, alerts

    try:
        with _pyniryo_lock:
            need_calib = bool(_call_first_available(robot, ["need_calibration"]))
        if need_calib:
            alerts.append({"level": "warning", "code": "needs_calibration",
                           "message": "Robot requires calibration"})
    except Exception as exc:
        alerts.append({"level": "warning", "code": "need_calibration_check_failed",
                       "message": str(exc)})

    try:
        with _pyniryo_lock:
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
def connect_robot() -> None:
    global _robot, _robot_ok, _robot_session_mode
    with _state_lock:
        _robot_session_mode = "connecting"

    try:
        from pyniryo import NiryoRobot
        log.info(f"Connecting to Niryo robot at {ROBOT_IP} …")
        robot = NiryoRobot(ROBOT_IP)
        log.info("Robot TCP connected successful")
        log.info("Calibrating …")
        with _pyniryo_lock:
            robot.calibrate_auto()
        log.info("Updating tool …")
        with _pyniryo_lock:
            robot.update_tool()

        with _state_lock:
            _robot, _robot_ok, _robot_session_mode = robot, True, "active"

        log.info("Moving to INSPECTION_POSE …")
        with _pyniryo_lock:
            robot.move_pose(INSPECTION_POSE)
        log.info(" Robot fully ready at INSPECTION_POSE")
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
    global _robot, _robot_ok
    log.warning(f"[reconnect] Rebuilding robot TCP socket — {reason}")
    with _state_lock:
        old = _robot
        _robot = None
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
        connect_robot()                    
        time.sleep(2.5)                    
        log.info("Robot recovery completed")
        return True
    except Exception as exc:
        log.error(f"Automatic recovery failed: {exc}", exc_info=True)
        return False
    finally:
        with _state_lock:
            _recovery_in_progress = False

def safe_move(pose, label: str = "?") -> None:
    """Cartesian move using PoseObject + robot.move_pose (the verified-working API)."""
    log.info(f"→ Moving to {label}")
    with _pyniryo_lock:
        _robot.move_pose(pose)
    log.info(f"  {label} reached ✔")


def close_gripper() -> None:
    tool, last_exc = getattr(_robot, "tool", None), None
    for target in [tool, _robot]:
        if target is None: continue
        for name in ["grasp_with_tool", "close_gripper", "gripper_close", "grasp", "close"]:
            fn = getattr(target, name, None)
            if not callable(fn): continue
            try:
                with _pyniryo_lock:
                    return fn(GRIPPER_SPEED)
            except TypeError:
                try:
                    with _pyniryo_lock:
                        return fn()
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
            try:
                with _pyniryo_lock:
                    return fn(GRIPPER_SPEED)
            except TypeError:
                try:
                    with _pyniryo_lock:
                        return fn()
                except Exception as e: last_exc = e
            except Exception as e: last_exc = e
    raise AttributeError(f"Gripper open not available" + (f": {last_exc}" if last_exc else ""))


def recalibrate_gripper() -> bool:
    if _robot is None:
        log.warning("[gripper] Cannot recalibrate — robot not connected.")
        return False
    log.warning("[gripper] Resetting gripper connection …")
    try:
        with _pyniryo_lock:
            _robot.update_tool()                
        time.sleep(1.0)
        with _pyniryo_lock:
            _robot.open_gripper(speed=500)      
        log.info("[gripper] Gripper recalibrated.")
        return True
    except Exception as exc:
        log.error(f"[gripper] Recalibration failed: {exc}")
        return False


_GRIPPER_TIMEOUT_S = 5.0   


def _call_with_timeout(fn, timeout_s: float, label: str):
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
    try:
        _call_with_timeout(action_fn, _GRIPPER_TIMEOUT_S, label)
        return
    except Exception as exc:
        log.warning(f"[gripper] {label} failed ({exc}) — attempting recalibration.")
    try:
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
DEFECTIVE_PROGRAM_PY = (
    "# -*- coding: utf-8 -*-\n"
    "# qc defective-product pick-and-place. Python 2 compatible (PEP-263).\n"
    "# Translated 1:1 from Niryo Studio Blockly file yog1.xml.\n"
    "from niryo_robot_python_ros_wrapper.ros_wrapper import NiryoRosWrapper\n"
    "import rospy\n"
    "\n"
    "try:\n"
    "    rospy.init_node('qc_defective_pick_place', anonymous=True)\n"
    "except rospy.exceptions.ROSException:\n"
    "    pass\n"
    "n = NiryoRosWrapper()\n"
    "\n"
    "# 1. Approach (home / start pose)\n"
    "n.move_pose(0.205, 0.041, 0.203, 1.545, 1.518, 1.466)\n"
    "# 2. Open gripper (OPEN_TORQUE=20, OPEN_HOLD_TORQUE=5)\n"
    "n.open_gripper(speed=500, max_torque_percentage=20, hold_torque_percentage=5)\n"
    "n.wait(5)\n"
    "\n"
    "# 3. Descend to pickup\n"
    "n.move_pose(0.286, 0.053, 0.115, -1.933, 1.49, -2.002)\n"
    "# 4. Close gripper on cup (CLOSE_TORQUE=10, CLOSE_HOLD_TORQUE=1)\n"
    "n.close_gripper(speed=500, max_torque_percentage=10, hold_torque_percentage=1)\n"
    "\n"
    "# 5. Lift after grasp\n"
    "n.move_pose(0.166, 0.145, 0.343, 0.481, 1.344, 0.866)\n"
    "# 6. Intermediate waypoint toward reject bin\n"
    "n.move_pose(-0.004, 0.255, 0.285, -0.43, 1.428, 1.082)\n"
    "# 7. Above reject bin\n"
    "n.move_pose(-0.08, 0.382, 0.112, -2.647, 1.421, -1.048)\n"
    "\n"
    "# 8. Release into bin\n"
    "n.open_gripper(speed=500, max_torque_percentage=20, hold_torque_percentage=5)\n"
    "n.wait(5)\n"
    "\n"
    "# 9. Lift after drop\n"
    "n.move_pose(-0.036, 0.365, 0.177, -0.055, 1.407, 1.521)\n"
    "# 10. Intermediate waypoint back\n"
    "n.move_pose(-0.004, 0.255, 0.285, -0.43, 1.428, 1.082)\n"
    "# 11. Return path waypoint\n"
    "n.move_pose(0.228, 0.039, 0.241, 2.916, 1.505, 2.951)\n"
    "# 12. Back to inspection home\n"
    "n.move_pose(0.205, 0.041, 0.203, 1.545, 1.518, 1.466)\n"
    "\n"
    "# 13. Close gripper at rest\n"
    "n.close_gripper(speed=500, max_torque_percentage=10, hold_torque_percentage=1)\n"
)


_resolved_program_language: Optional[int] = None


def _discover_program_languages() -> dict:
    try:
        import roslibpy
    except ImportError:
        return {}
    client = _get_ros_client()
    if client is None:
        return {}
    found: dict = {}
    for service_name in (
        "/niryo_robot_programs_manager/get_program_list",
        "/niryo_robot_programs_manager_v2/get_program_list",
    ):
        try:
            service = roslibpy.Service(client, service_name,
                                       "niryo_robot_programs_manager/GetProgramList")
            request = roslibpy.ServiceRequest({})
            result = service.call(request, timeout=8.0)
        except Exception as exc:
            log.debug(f"[lang-probe] {service_name} not available: {exc}")
            continue
        # Walk every list-valued field, pair language ints with names.
        names_field = next(
            (k for k in result if "name" in k.lower() and isinstance(result[k], list)),
            None,
        )
        langs_field = next(
            (k for k in result if "lang" in k.lower() and isinstance(result[k], list)),
            None,
        )
        if not langs_field:
            continue
        names = result.get(names_field, []) if names_field else []
        langs = result[langs_field]
        for i, lang in enumerate(langs):
            try:
                lang_int = int(lang.get("used") if isinstance(lang, dict) else lang)
            except (TypeError, ValueError):
                continue
            name = names[i] if i < len(names) else f"<idx {i}>"
            found.setdefault(lang_int, str(name))
        if found:
            log.info(f"[lang-probe] {service_name} reports language IDs: {found}")
            return found
    return found


def _language_probe_order() -> List[int]:
    seen: set = set()
    order: List[int] = []

    def _add(v: Optional[int]) -> None:
        if v is None: return
        if v in seen: return
        seen.add(v); order.append(v)

    _add(_resolved_program_language)
    _add(ROBOT_DEFECTIVE_PROGRAM_LANGUAGE)
    for v in (2, 1, 3, 0):  
        _add(v)
    try:
        discovered = _discover_program_languages()
    except Exception as exc:
        log.debug(f"[lang-probe] discovery failed: {exc}")
        discovered = {}
    for lang_int in discovered.keys():
        _add(lang_int)
    return order


def _remember_program_language(value: int) -> None:
    global _resolved_program_language
    if _resolved_program_language != value:
        log.info(f"[pick-place] caching working ProgramLanguage.used={value}")
        _resolved_program_language = value


def execute_pick_and_place(item_id: str, confidence: float) -> None:
    global _camera_paused
    log.info(f"━━━ START PICK & PLACE | Item={item_id} | inline-python (yog1 translation) ━━━")

    prev_paused = _camera_paused
    _camera_paused = True
    time.sleep(0.25)  

    try:
        candidates = _language_probe_order()
        ok, msg = False, ""
        for lang in candidates:
            ok, msg = _call_ros_service(
                "/niryo_robot_programs_manager/execute_program",
                "niryo_robot_programs_manager/ExecuteProgram",
                args={
                    "name": "",
                    "execute_from_string": True,
                    "code_string": DEFECTIVE_PROGRAM_PY,
                    "language": {"used": lang},
                },
                timeout=60.0,
            )
            if "Unknown Language" in msg:
                log.info(f"[pick-place] language={lang} not accepted; trying next")
                continue
            _remember_program_language(lang)
            break
    finally:
        _camera_paused = prev_paused

    if not ok:
        log.error(f"[pick-place] ROS execute_program failed for {item_id}: {msg}")
        _notify_backend_action(item_id, action="failed", error=msg)
        return

    log.info(f"[pick-place] ROS execute_program → {msg}")
    try:
        safe_move(INSPECTION_POSE, label="INSPECTION_POSE (post-program)")
    except Exception as exc:
        log.warning(f"[pick-place] post-program safe_move warning: {exc}")

    _notify_backend_action(item_id, action="completed")
    log.info(f"━━━ PICK & PLACE DONE for {item_id} ━━━")

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
_ros_client = None
_ros_client_lock = threading.Lock()


def _get_ros_client():
    """Return a connected roslibpy.Ros singleton, creating it on first use.
    Returns None if rosbridge is unreachable or roslibpy isn't installed."""
    global _ros_client
    try:
        import roslibpy
    except ImportError as exc:
        log.error(f"[ros] roslibpy not installed: {exc}")
        return None

    with _ros_client_lock:
        if _ros_client is not None and _ros_client.is_connected:
            return _ros_client
        if _ros_client is not None:
            try:
                _ros_client.terminate()
            except Exception:
                pass
            _ros_client = None

        client = roslibpy.Ros(host=ROBOT_IP, port=ROBOT_ROSBRIDGE_PORT)
        try:
            client.run(timeout=10)
        except Exception as exc:
            log.error(f"[ros] connect failed ({ROBOT_IP}:{ROBOT_ROSBRIDGE_PORT}): {exc}")
            return None

        if not client.is_connected:
            log.error(f"[ros] not connected after run() at {ROBOT_IP}:{ROBOT_ROSBRIDGE_PORT}")
            return None

        _ros_client = client
        log.info(f"[ros] rosbridge connected at {ROBOT_IP}:{ROBOT_ROSBRIDGE_PORT}")
        return _ros_client


def _call_ros_service(service_name: str, service_type: str,
                      args: Optional[dict] = None,
                      timeout: float = 25.0) -> Tuple[bool, str]:
    try:
        import roslibpy
    except ImportError as exc:
        return False, f"roslibpy not installed: {exc}"

    client = _get_ros_client()
    if client is None:
        return False, f"rosbridge unavailable at {ROBOT_IP}:{ROBOT_ROSBRIDGE_PORT}"

    try:
        service = roslibpy.Service(client, service_name, service_type)
        request = roslibpy.ServiceRequest(args or {})
        result = service.call(request, timeout=timeout)

        message = str(result.get("message", "")).strip() or "OK"
        if "success" in result:
            return bool(result["success"]), message
        if "status" in result:
            try:
                status = int(result["status"])
            except (TypeError, ValueError):
                status = 0
            return status >= 1, f"status={status} {message}".strip()
        return True, message
    except Exception as exc:
        return False, f"service call failed: {exc}"

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
        if robot is not None:
            tried: List[str] = []
            sound = getattr(robot, "sound", None)
            if sound is not None:
                say_fn = getattr(sound, "say", None)
                if callable(say_fn):
                    for args in [(text, 1), (text, "english"), (text,)]:
                        try:
                            with _pyniryo_lock:
                                say_fn(*args)
                            log.info(f"[say] robot.sound.say -> {text!r}")
                            return
                        except Exception as exc:
                            tried.append(f"sound.say{args}: {exc}")
            for name in ("say", "speak", "tts", "play_tts"):
                fn = getattr(robot, name, None)
                if callable(fn):
                    try:
                        with _pyniryo_lock:
                            fn(text)
                        log.info(f"[say] robot.{name} -> {text!r}")
                        return
                    except Exception as exc:
                        tried.append(f"{name}: {exc}")
            if tried:
                log.debug(f"[say] robot TTS not available: {tried}")
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
        "defect_type":     defect_type,        
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


def _is_pyniryo_desync(exc: BaseException) -> bool:
    if isinstance(exc, UnicodeDecodeError):
        return True
    msg = str(exc).lower()
    return ("utf-8" in msg or "utf8" in msg) and "can't decode byte" in msg


def _reboot_tool_sequence(robot, errors: List[str]) -> None:
    with _pyniryo_lock:
        robot.update_tool()
    time.sleep(0.3)
    fn = getattr(robot, "tool_reboot", None)
    if not callable(fn):
        errors.append("tool_reboot not available in this pyniryo build")
    else:
        try:
            with _pyniryo_lock:
                fn()
        except Exception as exc:
            if _is_pyniryo_desync(exc):
                raise
            errors.append(f"tool_reboot: {exc}")
    time.sleep(0.5)
    try:
        with _pyniryo_lock:
            robot.update_tool()
    except Exception as exc:
        if _is_pyniryo_desync(exc):
            raise
        errors.append(f"update_tool(post): {exc}")


@robot_app.route("/reboot-tool", methods=["POST"])
def reboot_tool():
    global _last_action, _camera_paused
    if not ensure_robot_ready():
        return jsonify({"message": "robot_not_ready"}), 503

    with _state_lock:
        if _robot is None:
            return jsonify({"message": "robot_not_ready"}), 503
        robot = _robot
        _last_action = "reboot_tool"

    errors: List[str] = []
    prev_paused = _camera_paused
    _camera_paused = True
    time.sleep(0.25)

    try:
        try:
            _reboot_tool_sequence(robot, errors)
        except Exception as exc:
            if not _is_pyniryo_desync(exc):
                raise
            log.warning(f"[reboot_tool] pyniryo socket desynced ({exc}) — "
                        f"rebuilding TCP and retrying once")
            if not reconnect_robot_socket(reason=f"reboot_tool desync: {exc}"):
                raise RuntimeError(f"socket rebuild failed: {exc}")
            with _state_lock:
                robot = _robot
            errors.append("recovered from socket desync")
            time.sleep(0.3)
            _reboot_tool_sequence(robot, errors)

        tool_name = getattr(getattr(robot, "tool", None), "current_tool_id", "unknown")
        msg = f"Tool rebooted ({tool_name})"
        if errors:
            msg += f" — warnings: {'; '.join(errors)}"
        log.info(msg)
        return jsonify({"message": msg})

    except Exception as exc:
        log.error(f"Tool reboot failed: {exc}", exc_info=True)
        return jsonify({"message": f"reboot failed: {exc}"}), 500
    finally:
        _camera_paused = prev_paused
        with _state_lock:
            _last_action = "idle"


@robot_app.route("/reboot-motors", methods=["POST"])
def reboot_motors():
    global _last_action, _robot_ok, _camera_paused
    if not ensure_robot_ready():
        return jsonify({"message": "robot_not_ready"}), 503

    with _state_lock:
        if _robot is None:
            return jsonify({"message": "robot_not_ready"}), 503
        robot = _robot
        _last_action = "reboot_motors"

    warnings: List[str] = []
    prev_paused = _camera_paused
    _camera_paused = True
    time.sleep(0.25) 

    try:
        ok, ros_msg = _call_ros_service(
            "/niryo_robot_hardware_interface/reboot_motors",
            "std_srvs/Trigger",
            timeout=30.0,
        )
        if not ok:
            log.error(f"[reboot_motors] ROS service failed: {ros_msg}")
            return jsonify({
                "message": f"reboot failed: {ros_msg}",
                "hint": "Ensure rosbridge_websocket is reachable on port "
                        f"{ROBOT_ROSBRIDGE_PORT} on {ROBOT_IP}.",
            }), 502

        log.info(f"[reboot_motors] ROS service reported: {ros_msg}")
        time.sleep(2.0)

        try:
            with _pyniryo_lock:
                robot.calibrate_auto()
        except Exception as exc:
            if _is_pyniryo_desync(exc):
                raise
            warnings.append(f"calibrate_auto: {exc}")

        try:
            with _pyniryo_lock:
                robot.update_tool()
        except Exception as exc:
            if _is_pyniryo_desync(exc):
                raise
            warnings.append(f"update_tool: {exc}")
        safe_move(INSPECTION_POSE, label="INSPECTION_POSE (after motors reboot)")

        with _state_lock:
            _robot_ok = True

        msg = f"Motors rebooted — {ros_msg}; re-homed at INSPECTION_POSE"
        if warnings:
            msg += f" — warnings: {'; '.join(warnings)}"
        log.info(msg)
        return jsonify({"message": msg})

    except Exception as exc:
        if _is_pyniryo_desync(exc):
            log.warning(f"[reboot_motors] pyniryo socket desynced ({exc}) — rebuilding TCP")
            reconnect_robot_socket(reason=f"reboot_motors desync: {exc}")
        log.error(f"Motors reboot failed: {exc}", exc_info=True)
        return jsonify({"message": f"reboot failed: {exc}"}), 500
    finally:
        _camera_paused = prev_paused
        with _state_lock:
            _last_action = "idle"


@robot_app.route("/calibrate", methods=["POST"])
def calibrate_robot():
    global _robot_ok, _last_action
    if not ensure_robot_ready(): return jsonify({"message": "robot_not_ready"}), 503
    with _state_lock:
        if _robot is None: return jsonify({"message": "robot_not_ready"}), 503
        prev_ready = _robot_ok;  _last_action = "calibrating"
        try:
            with _pyniryo_lock:
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
    from ai import _parse_dd_mmm

    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        raw  = body.get("reference_date")
        if raw is not None and not isinstance(raw, str):
            return jsonify({"error": "reference_date must be a string or null"}), 400
        if raw and _parse_dd_mmm(raw) is None:
            return jsonify({"error": f"Unparsable date: {raw!r}. Use 'DD MMM' (e.g. '12 AVR')."}), 400
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

def _camera_loop() -> None:
    global _camera_jpeg_bytes, _camera_frame_bgr, _camera_frame_count
    log.info("[camera] grabber thread started — pumping frames from robot.get_img_compressed()")
    fail_streak = 0
    RECONNECT_AFTER_STREAK = 20  
    RECONNECT_COOLDOWN_S   = 4.0 
    last_reconnect_ts = 0.0
    while True:
        with _state_lock:
            robot = _robot
            paused = _camera_paused
        if robot is None or paused:
            time.sleep(0.2)
            continue
        try:
            with _pyniryo_lock:
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
                    fail_streak = 0 
            time.sleep(0.1)


def start_camera_thread() -> None:
    if any(t.name == "camera-grabber" for t in threading.enumerate()):
        return
    threading.Thread(target=_camera_loop, daemon=True, name="camera-grabber").start()


def get_camera_frame_bgr() -> Optional[Tuple[np.ndarray, int]]:
    with _camera_lock:
        if _camera_frame_bgr is None:
            return None
        return _camera_frame_bgr.copy(), _camera_frame_count

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
        ok = _robot_ok
    with _camera_lock:
        have_frame = _camera_frame_bgr is not None
        count      = _camera_frame_count
    plc_tcp, plc_online = plc_heartbeat()
    return jsonify({
        "status":           "ok" if (ok and have_frame) else "degraded",
        "robot_connected":  ok,
        "frames_delivered": count,
        "plc_connected":    plc_tcp,
        "plc_online_bit":   plc_online,
    })


@stream_app.route("/plc/which-python", methods=["GET"])
def _plc_which_python():
    import sys
    return jsonify({"executable": sys.executable, "version": sys.version})


@stream_app.route("/plc/test", methods=["GET"])
def _plc_test():
    from config import _SNAP7_AVAILABLE, _plc_client, PLC_IP, PLC_RACK, PLC_SLOT, PLC_DB_NUMBER
    steps = {}

    steps["snap7_available"] = _SNAP7_AVAILABLE
    if not _SNAP7_AVAILABLE:
        return jsonify({"ok": False, "steps": steps, "error": "snap7 not installed in this Python env"})

    steps["client_created"] = _plc_client is not None
    if _plc_client is None:
        return jsonify({"ok": False, "steps": steps, "error": "snap7.client.Client() returned None"})

    try:
        already = _plc_client.get_connected()
        steps["already_connected"] = already
        if not already:
            _plc_client.connect(PLC_IP, PLC_RACK, PLC_SLOT)
        steps["connected"] = _plc_client.get_connected()
    except Exception as exc:
        steps["connected"] = False
        return jsonify({"ok": False, "steps": steps, "error": f"connect() failed: {type(exc).__name__}: {exc}"})

    try:
        data = _plc_client.db_read(PLC_DB_NUMBER, 0, 1)
        steps["db_read"] = True
        steps["db_read_hex"] = data.hex()
    except Exception as exc:
        steps["db_read"] = False
        return jsonify({"ok": False, "steps": steps, "error": f"db_read() failed: {type(exc).__name__}: {exc}"})

    try:
        from snap7.util import get_bool
        steps["bit_0_0"] = bool(get_bool(data, 0, 0))
        steps["bit_0_1"] = bool(get_bool(data, 0, 1))
        steps["bit_0_2"] = bool(get_bool(data, 0, 2))
    except Exception as exc:
        return jsonify({"ok": False, "steps": steps, "error": f"get_bool() failed: {exc}"})

    return jsonify({"ok": True, "steps": steps})


@stream_app.route("/robot-health", methods=["GET"])
def _stream_robot_health():
    with _state_lock:
        ok = _robot_ok
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
