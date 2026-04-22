"""
niryo_stream.py
───────────────
MJPEG stream server for the Niryo Ned2 robot camera.
Runs on port 5001.  The Angular dashboard connects via:
    <img src="http://<host>:5001/stream">

Dependencies:
    pip install flask flask-cors opencv-python pyniryo2 waitress roslibpy==1.3.0 numpy

Start manually:
    python niryo_stream.py

Or let the Node.js backend (server.js) spawn it automatically on startup.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DEPLOYMENT GUIDE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┌─────────────────────────────────────────────────────────┐
  │  CURRENT SETUP — Developer PC (internship mode)         │
  ├─────────────────────────────────────────────────────────┤
  │  • niryo_stream.py runs on YOUR PC                      │
  │  • Angular app runs on YOUR PC (localhost:4200)         │
  │  • PC must be connected to the Niryo WiFi hotspot       │
  │  • Robot IP stays 10.10.10.10 (Niryo default hotspot)   │
  │  • Angular .ts: streamHost = 'localhost'                │
  │  • Stream URL seen by browser: http://localhost:5001    │
  └─────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────┐
  │  FUTURE SETUP — Raspberry Pi (production handoff)       │
  ├─────────────────────────────────────────────────────────┤
  │  • niryo_stream.py runs ON the Raspberry Pi             │
  │  • Angular app runs ON the Raspberry Pi (or served      │
  │    via nginx on the Pi)                                 │
  │  • Pi must be connected to the Niryo WiFi hotspot       │
  │  • Robot IP stays 10.10.10.10 (no change needed here)   │
  │  • Angular .ts: streamHost = '<PI_IP>' e.g. 192.168.1.x │
  │    or 'localhost' if Angular also runs on the Pi        │
  │  • Stream URL seen by browser: http://<PI_IP>:5001      │
  │                                                         │
  │  On the Pi, install dependencies once:                  │
  │    pip install flask flask-cors opencv-python \         │
  │                pyniryo2 waitress numpy                  │
  │    pip install roslibpy==1.3.0                          │
  │                                                         │
  │  To auto-start on boot, create a systemd service:       │
  │    /etc/systemd/system/niryo-stream.service             │
  │    (see comment at bottom of this file)                 │
  └─────────────────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import cv2
import time
import threading
import numpy as np
import roslibpy
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from flask import Flask, Response, jsonify, request
from flask_cors import CORS

# ── Try to import pyniryo2 ────────────────────────────────────────────────────
# NOTE: pyniryo2 requires roslibpy==1.3.0 (newer versions removed actionlib)
#       Install with: pip install pyniryo2 roslibpy==1.3.0
try:
    from pyniryo2 import NiryoRobot
    try:
        from pyniryo2.vision import uncompress_image
    except ImportError:
        # Fallback: decompress manually using OpenCV
        def uncompress_image(compressed):
            np_arr = np.frombuffer(compressed, np.uint8)
            return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    PYNIRYO_AVAILABLE = True
    print("[niryo_stream] pyniryo2 found — will connect to Ned2")
except ImportError:
    PYNIRYO_AVAILABLE = False
    print("[niryo_stream] pyniryo2 not installed — running in placeholder mode")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CONFIG
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ── Robot IP ──────────────────────────────────────────────────────────────────
# PC mode    → keep as-is. Your PC connects directly to Niryo WiFi hotspot.
# Pi mode    → keep as-is. The Pi connects to the same Niryo WiFi hotspot.
#              The robot's hotspot IP is always 10.10.10.10 (Niryo default).
ROBOT_IP = "10.10.10.10"

# ── Stream port ───────────────────────────────────────────────────────────────
# PC mode    → Flask serves on this port on YOUR PC → Angular reads localhost:5001
# Pi mode    → Flask serves on this port on the PI  → Angular reads <PI_IP>:5001
#              Make sure port 5001 is open on the Pi firewall:
#              sudo ufw allow 5001
STREAM_PORT = 5001

JPEG_QUALITY  = 80   # 0-100 — lower = faster stream, higher = better quality
TARGET_FPS    = 20   # Niryo SDK cannot reliably exceed ~20 FPS
RECONNECT_SEC = 8    # seconds between reconnect attempts after disconnect
CONNECT_TIMEOUT = 15 # seconds to wait for NiryoRobot() constructor
FRAME_TIMEOUT   = 5  # seconds to wait for get_img_compressed()
STALE_FRAME_SEC = 10 # seconds before declaring the capture thread stuck

# ── Health monitoring thresholds ──────────────────────────────────────────────
MOTOR_TEMP_WARN     = 55   # degrees C — warning
MOTOR_TEMP_CRITICAL = 65   # degrees C — critical (risk of damage)
RPI_TEMP_WARN       = 75   # degrees C
RPI_TEMP_CRITICAL   = 85   # degrees C
VOLTAGE_MIN         = 10.5 # volts — below this motors may stall
VOLTAGE_MAX         = 13.5 # volts — above this may indicate PSU issue

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app = Flask(__name__)
CORS(app)  # Allow Angular (any origin) to consume the stream

# ── Shared state (protected by _lock) ────────────────────────────────────────
_lock         = threading.Lock()
_latest_frame = None   # bytes: latest JPEG frame
_robot        = None   # NiryoRobot instance or None
_start_time   = time.time()
_frame_count  = 0
_last_frame_time = time.time()  # timestamp of last successful frame capture
_camera_status   = "Initializing…"  # human-readable camera status for placeholder

# ── Thread pools for timeout-wrapped blocking calls ─────────────────────────
# Separate executor for connection management so fire-and-forget actions
# (like reboot_motors) can't exhaust the pool used for (re)connecting.
_executor        = ThreadPoolExecutor(max_workers=4)   # camera / health / misc
_action_executor = ThreadPoolExecutor(max_workers=2)   # robot actions only


def _check_ros_bridge_ready() -> bool:
    """Quick check if the robot's ROS bridge (port 9090) is accepting connections."""
    import socket
    try:
        s = socket.create_connection((ROBOT_IP, 9090), timeout=3)
        s.close()
        return True
    except (OSError, socket.timeout):
        return False

# ── Robot health state (protected by _health_lock) ──────────────────────────
_health_lock = threading.Lock()
_health_data = {
    "hardware_status": {
        "temperatures": [],
        "voltages": [],
        "hardware_errors": [],
        "hardware_errors_message": [],
        "calibration_needed": False,
        "calibration_in_progress": False,
        "motor_names": [],
        "motor_types": [],
        "rpi_temperature": 0,
        "connection_up": False,
        "hardware_version": "",
    },
    "robot_status": {
        "robot_status_str": "",
        "robot_message": "",
        "rpi_overheating": False,
        "out_of_bounds": False,
        "logs_status_str": "",
    },
    "joint_states": {
        "position": [],
        "velocity": [],
        "effort": [],
        "name": [],
    },
    "collision_detected": False,
    "alerts": [],
    "last_updated": None,
}
_health_topics = []  # roslibpy.Topic refs for cleanup on disconnect

# ── Allowed robot actions ────────────────────────────────────────────────────
# Format: "action_name": (service_path, service_type, args, timeout, fire_and_forget)
# fire_and_forget=True means the service reboots hardware and never responds
ROBOT_ACTIONS = {
    "reboot_motors":            ("/niryo_robot_hardware_interface/reboot_motors",    "niryo_robot_msgs/Trigger",  {},              3, True),
    "calibrate_auto":           ("/niryo_robot/joints_interface/calibrate_motors",   "niryo_robot_msgs/SetInt",   {"value": 1},   30, False),
    "request_new_calibration":  ("/niryo_robot/joints_interface/request_new_calibration", "niryo_robot_msgs/Trigger", {},          10, False),
    "learning_mode_on":         ("/niryo_robot/learning_mode/activate",              "niryo_robot_msgs/SetBool",  {"value": True}, 5, False),
    "learning_mode_off":        ("/niryo_robot/learning_mode/activate",              "niryo_robot_msgs/SetBool",  {"value": False},5, False),
    "stop_command":             ("/niryo_robot_arm_commander/stop_command",          "niryo_robot_msgs/Trigger",  {},              5, False),
    "reboot_tool":              ("/niryo_robot/tools/reboot",                        "std_srvs/Trigger",          {},             10, False),
    "enable_video_stream":      ("/niryo_robot_vision/start_stop_video_streaming",  "niryo_robot_msgs/SetBool",  {"value": True}, 10, False),
}


# ── Health topic callbacks ───────────────────────────────────────────────────

def _on_hardware_status(msg):
    """Callback for /niryo_robot_hardware_interface/hardware_status"""
    with _health_lock:
        hs = _health_data["hardware_status"]
        hs["temperatures"]           = msg.get("temperatures", [])
        hs["voltages"]               = msg.get("voltages", [])
        hs["hardware_errors"]        = msg.get("hardware_errors", [])
        hs["hardware_errors_message"] = msg.get("hardware_errors_message", [])
        hs["calibration_needed"]     = msg.get("calibration_needed", False)
        hs["calibration_in_progress"] = msg.get("calibration_in_progress", False)
        hs["motor_names"]            = msg.get("motor_names", [])
        hs["motor_types"]            = msg.get("motor_types", [])
        hs["rpi_temperature"]        = msg.get("rpi_temperature", 0)
        hs["connection_up"]          = msg.get("connection_up", False)
        hs["hardware_version"]       = msg.get("hardware_version", "")
    _evaluate_alerts()


def _on_robot_status(msg):
    """Callback for /niryo_robot_status/robot_status"""
    with _health_lock:
        rs = _health_data["robot_status"]
        rs["robot_status_str"] = msg.get("robot_status_str", "")
        rs["robot_message"]    = msg.get("robot_message", "")
        rs["rpi_overheating"]  = msg.get("rpi_overheating", False)
        rs["out_of_bounds"]    = msg.get("out_of_bounds", False)
        rs["logs_status_str"]  = msg.get("logs_status_str", "")
    _evaluate_alerts()


def _on_joint_states(msg):
    """Callback for /joint_states"""
    with _health_lock:
        js = _health_data["joint_states"]
        js["position"] = msg.get("position", [])
        js["velocity"] = msg.get("velocity", [])
        js["effort"]   = msg.get("effort", [])
        js["name"]     = msg.get("name", [])


def _on_collision(msg):
    """Callback for /niryo_robot/hardware_interface/collision_detected"""
    with _health_lock:
        _health_data["collision_detected"] = msg.get("data", False)
    _evaluate_alerts()


def _evaluate_alerts():
    """Check thresholds and build the active alerts list."""
    now = datetime.now(timezone.utc).isoformat()
    alerts = []

    with _health_lock:
        hs = _health_data["hardware_status"]
        rs = _health_data["robot_status"]
        collision = _health_data["collision_detected"]

    # Motor temperatures
    for i, temp in enumerate(hs.get("temperatures", [])):
        name = hs["motor_names"][i] if i < len(hs["motor_names"]) else f"motor_{i}"
        if temp >= MOTOR_TEMP_CRITICAL:
            alerts.append({"id": f"temp_critical_{name}", "severity": "critical",
                           "message": f"{name} temperature {temp}C — CRITICAL (>{MOTOR_TEMP_CRITICAL}C)",
                           "source": "hardware_status", "timestamp": now})
        elif temp >= MOTOR_TEMP_WARN:
            alerts.append({"id": f"temp_warn_{name}", "severity": "warning",
                           "message": f"{name} temperature {temp}C — high (>{MOTOR_TEMP_WARN}C)",
                           "source": "hardware_status", "timestamp": now})

    # RPi temperature
    rpi_temp = hs.get("rpi_temperature", 0)
    if rpi_temp >= RPI_TEMP_CRITICAL:
        alerts.append({"id": "rpi_temp_critical", "severity": "critical",
                       "message": f"RPi temperature {rpi_temp}C — CRITICAL",
                       "source": "hardware_status", "timestamp": now})
    elif rpi_temp >= RPI_TEMP_WARN:
        alerts.append({"id": "rpi_temp_warn", "severity": "warning",
                       "message": f"RPi temperature {rpi_temp}C — high",
                       "source": "hardware_status", "timestamp": now})

    # Motor voltages (only check stepper motors — first 3 entries)
    for i, volt in enumerate(hs.get("voltages", [])[:3]):
        name = hs["motor_names"][i] if i < len(hs["motor_names"]) else f"motor_{i}"
        if volt < VOLTAGE_MIN:
            alerts.append({"id": f"volt_low_{name}", "severity": "warning",
                           "message": f"{name} voltage {volt:.1f}V — low (<{VOLTAGE_MIN}V)",
                           "source": "hardware_status", "timestamp": now})
        elif volt > VOLTAGE_MAX:
            alerts.append({"id": f"volt_high_{name}", "severity": "warning",
                           "message": f"{name} voltage {volt:.1f}V — high (>{VOLTAGE_MAX}V)",
                           "source": "hardware_status", "timestamp": now})

    # Hardware errors
    for i, err in enumerate(hs.get("hardware_errors", [])):
        if err != 0:
            name = hs["motor_names"][i] if i < len(hs["motor_names"]) else f"motor_{i}"
            err_msg = hs["hardware_errors_message"][i] if i < len(hs["hardware_errors_message"]) else ""
            alerts.append({"id": f"hw_error_{name}", "severity": "critical",
                           "message": f"{name} hardware error ({err}): {err_msg}",
                           "source": "hardware_status", "timestamp": now})

    # Calibration needed
    if hs.get("calibration_needed"):
        alerts.append({"id": "calibration_needed", "severity": "warning",
                       "message": "Robot needs calibration",
                       "source": "hardware_status", "timestamp": now})

    # Connection lost
    if not hs.get("connection_up", True):
        alerts.append({"id": "connection_down", "severity": "critical",
                       "message": "Hardware interface connection lost",
                       "source": "hardware_status", "timestamp": now})

    # Collision detected
    if collision:
        alerts.append({"id": "collision", "severity": "critical",
                       "message": "Collision detected — robot stopped",
                       "source": "collision", "timestamp": now})

    # Out of bounds
    if rs.get("out_of_bounds"):
        alerts.append({"id": "out_of_bounds", "severity": "critical",
                       "message": "Robot arm out of bounds",
                       "source": "robot_status", "timestamp": now})

    # RPi overheating (from robot_status)
    if rs.get("rpi_overheating"):
        alerts.append({"id": "rpi_overheating", "severity": "critical",
                       "message": "Raspberry Pi overheating — throttling active",
                       "source": "robot_status", "timestamp": now})

    with _health_lock:
        _health_data["alerts"] = alerts
        _health_data["last_updated"] = now


def _subscribe_health_topics(robot_ref):
    """Subscribe to all robot health ROS topics. Call after connecting."""
    global _health_topics
    ros_client = robot_ref.client

    topics_config = [
        ('/niryo_robot_hardware_interface/hardware_status', 'niryo_robot_msgs/HardwareStatus', _on_hardware_status),
        ('/niryo_robot_status/robot_status',                'niryo_robot_status/RobotStatus',   _on_robot_status),
        ('/joint_states',                                   'sensor_msgs/JointState',           _on_joint_states),
        ('/niryo_robot/hardware_interface/collision_detected', 'std_msgs/Bool',                 _on_collision),
    ]

    for topic_name, topic_type, callback in topics_config:
        try:
            t = roslibpy.Topic(ros_client, topic_name, topic_type)
            t.subscribe(callback)
            _health_topics.append(t)
            print(f"[niryo_stream] Subscribed to {topic_name}")
        except Exception as e:
            print(f"[niryo_stream] Could not subscribe to {topic_name}: {e}")


def _unsubscribe_health_topics():
    """Unsubscribe from all health topics on disconnect."""
    global _health_topics
    for t in _health_topics:
        try:
            t.unsubscribe()
        except Exception:
            pass
    _health_topics = []


# ── Placeholder frame ─────────────────────────────────────────────────────────

def _make_placeholder_frame() -> bytes:
    """Dark 'CONNECTING' frame shown while robot is not yet reachable."""
    img = np.zeros((480, 640, 3), dtype=np.uint8)
    img[:] = (13, 19, 33)

    cv2.rectangle(img, (20, 20), (620, 460), (67, 97, 238), 1)

    # Camera icon
    cv2.circle(img, (320, 190), 40, (61, 80, 112), -1)
    cv2.circle(img, (320, 190), 26, (13, 19, 33), -1)
    cv2.rectangle(img, (280, 170), (360, 210), (13, 19, 33), -1)
    cv2.rectangle(img, (274, 178), (366, 212), (61, 80, 112), 2)

    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(img, "CONNECTING TO NIRYO...", (155, 280),
                font, 0.65, (107, 126, 160), 1, cv2.LINE_AA)
    cv2.putText(img, f"Robot: {ROBOT_IP}", (235, 310),
                font, 0.45, (67, 97, 238), 1, cv2.LINE_AA)

    # Show camera status so the user knows what's happening
    with _lock:
        status = _camera_status
    cv2.putText(img, status, (20, 370),
                font, 0.42, (100, 140, 200), 1, cv2.LINE_AA)
    cv2.putText(img, time.strftime("%H:%M:%S"), (16, 454),
                font, 0.38, (61, 80, 112), 1, cv2.LINE_AA)

    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    return buf.tobytes()


def _enable_video_stream(robot_ref) -> bool:
    """
    Call the robot's start_stop_video_streaming ROS service to enable the
    camera stream. Returns True if the stream was activated successfully.
    Wrapped in a timeout to avoid blocking the capture thread.
    """
    global _camera_status

    def _do_enable():
        ros_client = robot_ref.client
        service = roslibpy.Service(
            ros_client,
            '/niryo_robot_vision/start_stop_video_streaming',
            'niryo_robot_msgs/SetBool'
        )
        return service.call(roslibpy.ServiceRequest({'value': True}))

    try:
        future = _executor.submit(_do_enable)
        result = future.result(timeout=10)
        msg = result.get('message', '')
        status = result.get('status', -1)

        if status >= 0:
            print(f"[niryo_stream] Video stream enabled: {msg}")
            with _lock:
                _camera_status = "Video stream enabled — waiting for frames"
            return True
        else:
            print(f"[niryo_stream] Video stream activation failed: {msg}")
            with _lock:
                _camera_status = f"Camera: {msg}"
            return False
    except FuturesTimeout:
        print("[niryo_stream] Enable video stream service timed out (10s)")
        with _lock:
            _camera_status = "Video stream service timed out"
        return False
    except Exception as e:
        print(f"[niryo_stream] Could not enable video stream: {e}")
        with _lock:
            _camera_status = f"Stream service error: {e}"
        return False


# ── Safe disconnect (timeout-wrapped) ────────────────────────────────────────

def _reset_health_data():
    """Reset health data to defaults so stale values aren't served after disconnect."""
    with _health_lock:
        _health_data["hardware_status"] = {
            "temperatures": [], "voltages": [], "hardware_errors": [],
            "hardware_errors_message": [], "calibration_needed": False,
            "calibration_in_progress": False, "motor_names": [], "motor_types": [],
            "rpi_temperature": 0, "connection_up": False, "hardware_version": "",
        }
        _health_data["robot_status"] = {
            "robot_status_str": "", "robot_message": "", "rpi_overheating": False,
            "out_of_bounds": False, "logs_status_str": "",
        }
        _health_data["joint_states"] = {
            "position": [], "velocity": [], "effort": [], "name": [],
        }
        _health_data["collision_detected"] = False
        _health_data["alerts"] = []
        _health_data["last_updated"] = datetime.now(timezone.utc).isoformat()


def _safe_disconnect(robot_ref):
    """Disconnect the robot with a timeout so a hung ROS bridge can't freeze us."""
    global _robot, _latest_frame
    _unsubscribe_health_topics()
    _reset_health_data()
    with _lock:
        _robot = None
        _latest_frame = None          # ← clear stale frame so placeholder shows
        _camera_status = "Disconnected — will reconnect..."
    # Use a fresh thread for disconnect so we don't block any executor
    def _do_disconnect():
        try:
            robot_ref.disconnect()
        except Exception:
            pass
    t = threading.Thread(target=_do_disconnect, daemon=True)
    t.start()
    t.join(timeout=3)  # wait at most 3s, then abandon


# ── Background capture thread ─────────────────────────────────────────────────

def _on_frame_callback(img_compressed):
    """
    Called by the persistent ROS topic subscription whenever a new
    compressed frame arrives from the robot camera.
    """
    global _latest_frame, _frame_count, _last_frame_time
    try:
        img = uncompress_image(img_compressed)
        _, buf = cv2.imencode('.jpg', img,
                              [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        frame = buf.tobytes()
        with _lock:
            _latest_frame = frame
            _frame_count += 1
            _last_frame_time = time.time()
    except Exception as e:
        print(f"[niryo_stream] Frame decode error: {e}")


def _capture_loop():
    """
    Runs forever in a daemon thread.
    Connects to the robot and uses a persistent ROS topic subscription
    (via NiryoTopic.subscribe) to receive frames through a callback.
    Falls back to polling if subscription-based streaming fails.

    IMPORTANT: Close Niryo Studio before running — the robot only allows
               one TCP client at a time. Niryo Studio will block pyniryo2.
    """
    global _robot, _latest_frame, _frame_count, _last_frame_time, _camera_status

    last_attempt   = 0.0
    subscribed     = False

    while True:
        # ── (Re)connect if needed ─────────────────────────────────────────
        with _lock:
            robot_ref = _robot

        if robot_ref is None:
            subscribed = False
            now = time.time()
            if now - last_attempt >= RECONNECT_SEC:
                last_attempt = now
                if PYNIRYO_AVAILABLE:
                    # Quick pre-check: is the ROS bridge even accepting TCP?
                    # This avoids spawning a heavy NiryoRobot() when the robot
                    # is still rebooting and ROS isn't up yet.
                    with _lock:
                        _camera_status = f"Checking {ROBOT_IP}:9090..."
                    if not _check_ros_bridge_ready():
                        print(f"[niryo_stream] ROS bridge not ready on {ROBOT_IP}:9090 — will retry in {RECONNECT_SEC}s")
                        with _lock:
                            _camera_status = f"ROS bridge not ready — retrying in {RECONNECT_SEC}s"
                    else:
                        with _lock:
                            _camera_status = f"Connecting to {ROBOT_IP}..."
                        try:
                            # Use a fresh thread (not executor) so timed-out
                            # connections don't permanently occupy pool workers.
                            result_holder = [None]
                            error_holder = [None]
                            def _do_connect():
                                try:
                                    result_holder[0] = NiryoRobot(ROBOT_IP)
                                except Exception as ex:
                                    error_holder[0] = ex
                            ct = threading.Thread(target=_do_connect, daemon=True)
                            ct.start()
                            ct.join(timeout=CONNECT_TIMEOUT)

                            if ct.is_alive():
                                raise FuturesTimeout(f"Connection timed out ({CONNECT_TIMEOUT}s)")
                            if error_holder[0] is not None:
                                raise error_holder[0]

                            r = result_holder[0]
                            with _lock:
                                _robot = r
                                _camera_status = "Connected — calibrating arm..."
                            robot_ref = r
                            print(f"[niryo_stream] Connected to Niryo Ned2 at {ROBOT_IP}")

                            # Auto-calibrate — camera topic may not publish
                            # until the arm has been calibrated at least once.
                            try:
                                future = _executor.submit(r.arm.calibrate_auto)
                                future.result(timeout=30)
                                print("[niryo_stream] Auto-calibration complete")
                            except FuturesTimeout:
                                print("[niryo_stream] Calibration timed out (may already be calibrated)")
                            except Exception as e:
                                print(f"[niryo_stream] Calibration note: {e}")

                            # Enable the video stream via ROS service —
                            # the stream is OFF by default on Ned2.
                            with _lock:
                                _camera_status = "Enabling video stream..."
                            _enable_video_stream(r)

                            # Subscribe to all health monitoring topics
                            _subscribe_health_topics(r)

                        except FuturesTimeout:
                            print(f"[niryo_stream] Connection timed out after {CONNECT_TIMEOUT}s — is Niryo Studio open?")
                            with _lock:
                                _camera_status = f"Connection timed out — close Niryo Studio if open"
                        except Exception as e:
                            err_str = str(e)
                            print(f"[niryo_stream] Cannot connect: {err_str}")
                            # Common case: another client (Niryo Studio) is blocking
                            if "refused" in err_str.lower() or "reset" in err_str.lower():
                                with _lock:
                                    _camera_status = "Connection refused — another client may be connected (close Niryo Studio)"
                            else:
                                with _lock:
                                    _camera_status = f"Connection failed: {err_str[:100]}"

            # Show placeholder while disconnected
            frame = _make_placeholder_frame()
            with _lock:
                _latest_frame = frame
            time.sleep(1)
            continue

        # ── Subscribe to video stream topic (persistent) ──────────────────
        if not subscribed:
            try:
                topic = robot_ref.vision.get_img_compressed
                if not topic.is_subscribed:
                    topic.subscribe(_on_frame_callback)
                subscribed = True
                print("[niryo_stream] Subscribed to compressed video stream topic")
            except Exception as e:
                print(f"[niryo_stream] Subscribe error: {e} — will retry")
                time.sleep(2)
                continue

        # ── Check for stale frames (subscription may have silently died) ──
        with _lock:
            age = time.time() - _last_frame_time

        if age > STALE_FRAME_SEC:
            # Try one poll as a health check — if this also fails, disconnect
            try:
                future = _executor.submit(robot_ref.vision.get_img_compressed)
                img_compressed = future.result(timeout=FRAME_TIMEOUT)
                if img_compressed is not None:
                    _on_frame_callback(img_compressed)
                else:
                    print(f"[niryo_stream] No frames for {age:.0f}s (poll also returned None) — reconnecting")
                    _safe_disconnect(robot_ref)
                    subscribed = False
                    continue
            except Exception as e:
                print(f"[niryo_stream] Stale stream, poll failed: {e} — reconnecting")
                _safe_disconnect(robot_ref)
                subscribed = False
                continue

        time.sleep(0.5)


# ── Flask routes ──────────────────────────────────────────────────────────────

def _generate_mjpeg():
    """Yields MJPEG multipart chunks from _latest_frame."""
    while True:
        with _lock:
            frame = _latest_frame
            stale = (time.time() - _last_frame_time) > STALE_FRAME_SEC

        if frame is None or stale:
            # Send placeholder so the browser doesn't think stream died
            frame = _make_placeholder_frame()
            time.sleep(0.5)

        yield (
            b'--frame\r\n'
            b'Content-Type: image/jpeg\r\n'
            b'Content-Length: ' + str(len(frame)).encode() + b'\r\n'
            b'\r\n' + frame + b'\r\n'
        )
        time.sleep(1.0 / TARGET_FPS)


@app.route('/stream')
def stream():
    """MJPEG stream consumed by the Angular <img> tag."""
    return Response(
        _generate_mjpeg(),
        mimetype='multipart/x-mixed-replace; boundary=frame',
        headers={
            'Cache-Control':     'no-cache, no-store, must-revalidate',
            'Pragma':            'no-cache',
            'Expires':           '0',
            'X-Accel-Buffering': 'no',
        }
    )


@app.route('/health')
def health():
    """Health check — open http://localhost:5001/health to verify."""
    with _lock:
        connected = _robot is not None
        frames    = _frame_count
        last_ts   = _last_frame_time
        cam_stat  = _camera_status
    uptime = round(time.time() - _start_time, 1)
    fps    = round(frames / max(uptime, 1), 1)
    stale  = (time.time() - last_ts) > STALE_FRAME_SEC
    return jsonify({
        'status':            'ok',
        'robot_connected':   connected,
        'pyniryo_available': PYNIRYO_AVAILABLE,
        'robot_ip':          ROBOT_IP,
        'uptime_sec':        uptime,
        'frames_captured':   frames,
        'avg_fps':           fps,
        'stream_stale':      stale,
        'last_frame_age_sec': round(time.time() - last_ts, 1),
        'camera_status':     cam_stat,
    })


@app.route('/robot-health')
def robot_health():
    """Full robot health snapshot — polled by server.js every 3s."""
    with _health_lock:
        import copy
        data = copy.deepcopy(_health_data)
    with _lock:
        connected = _robot is not None
    data["robot_connected"] = connected
    # If pyniryo2 is connected, connection_up must be true even if the
    # ROS topic callback hasn't fired yet (avoids brief false→true flicker).
    if connected:
        data["hardware_status"]["connection_up"] = True
    return jsonify(data)


@app.route('/robot-action', methods=['POST'])
def robot_action():
    """
    Trigger a ROS service on the robot.
    Body: { "action": "reboot_motors" | "calibrate_auto" | ... }
    Called by server.js (which adds auth before proxying here).
    """
    body = request.get_json(silent=True) or {}
    action = body.get("action", "")

    if action not in ROBOT_ACTIONS:
        return jsonify({"success": False, "message": f"Unknown action: {action}. Allowed: {list(ROBOT_ACTIONS.keys())}"}), 400

    with _lock:
        robot_ref = _robot
    if robot_ref is None:
        return jsonify({"success": False, "message": "Robot not connected"}), 503

    service_path, service_type, service_args, timeout, fire_and_forget = ROBOT_ACTIONS[action]

    def _do_call():
        service = roslibpy.Service(robot_ref.client, service_path, service_type)
        return service.call(roslibpy.ServiceRequest(service_args))

    try:
        future = _action_executor.submit(_do_call)
        result = future.result(timeout=timeout)

        # ── Extract message & success from the ROS ServiceResponse ───
        # ServiceResponse (UserDict subclass) is NOT JSON-serializable.
        # We extract ONLY primitive values — never pass the object to jsonify.
        import json
        msg = "OK"
        success = True
        try:
            # Serialize to JSON string then back — strips all non-primitive types
            raw = json.loads(json.dumps(
                result.data if hasattr(result, 'data') else dict(result),
                default=str
            ))
            msg = str(raw.get("message", json.dumps(raw)))
            # {status: int, message} or {success: bool, message}
            if "success" in raw:
                success = bool(raw["success"])
            elif "status" in raw:
                success = int(raw["status"]) >= 0
        except Exception:
            msg = f"Action '{action}' completed (response: {str(result)[:200]})"
            success = True

        print(f"[niryo_stream] Action '{action}' result: {msg}")
        return jsonify({"success": success, "message": msg})
    except FuturesTimeout:
        if fire_and_forget:
            # Expected: reboot_motors reboots hardware and never responds.
            # Force disconnect so the reconnect loop will auto-reconnect
            # once the robot finishes rebooting.
            print(f"[niryo_stream] Action '{action}' sent (fire-and-forget) — forcing reconnect")
            threading.Thread(target=_safe_disconnect, args=(robot_ref,), daemon=True).start()
            return jsonify({"success": True, "message": f"{action} command sent — robot is rebooting, will auto-reconnect"})
        return jsonify({"success": False, "message": f"Action '{action}' timed out ({timeout}s)"}), 504
    except Exception as e:
        if fire_and_forget:
            print(f"[niryo_stream] Action '{action}' sent (fire-and-forget, connection dropped) — forcing reconnect")
            threading.Thread(target=_safe_disconnect, args=(robot_ref,), daemon=True).start()
            return jsonify({"success": True, "message": f"{action} command sent — robot is rebooting, will auto-reconnect"})
        return jsonify({"success": False, "message": str(e)}), 500


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print(f"[niryo_stream] Starting MJPEG stream server on port {STREAM_PORT}")

    t = threading.Thread(target=_capture_loop, daemon=True)
    t.start()

    try:
        from waitress import serve
        print("[niryo_stream] Using Waitress WSGI server")
        serve(app, host='0.0.0.0', port=STREAM_PORT, threads=8,
              channel_timeout=300)
    except ImportError:
        print("[niryo_stream] Waitress not found — falling back to Flask dev server")
        app.run(host='0.0.0.0', port=STREAM_PORT, threaded=True)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  RASPBERRY PI AUTO-START (systemd service)
#  When handing off to the organization, create this file on the Pi:
#
#  sudo nano /etc/systemd/system/niryo-stream.service
#
#  Paste:
#  ┌──────────────────────────────────────────────────────────┐
#  │ [Unit]                                                   │
#  │ Description=Niryo MJPEG Stream Server                   │
#  │ After=network.target                                     │
#  │                                                          │
#  │ [Service]                                                │
#  │ ExecStart=/usr/bin/python3 /home/pi/niryo_stream.py     │
#  │ WorkingDirectory=/home/pi                                │
#  │ Restart=always                                           │
#  │ RestartSec=5                                             │
#  │ User=pi                                                  │
#  │                                                          │
#  │ [Install]                                                │
#  │ WantedBy=multi-user.target                               │
#  └──────────────────────────────────────────────────────────┘
#
#  Then enable it:
#  sudo systemctl daemon-reload
#  sudo systemctl enable niryo-stream
#  sudo systemctl start niryo-stream
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━