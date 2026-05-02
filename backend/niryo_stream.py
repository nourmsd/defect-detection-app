"""
niryo_stream.py — Niryo Robot Camera MJPEG Stream Server
=========================================================
Serves a live MJPEG stream from the Niryo robot's onboard camera
on http://0.0.0.0:5001/stream and exposes /health and /robot-health
endpoints consumed by the Node.js backend and Angular dashboard.

CAMERA SOURCE:  pyniryo  NiryoRobot.get_img_compressed()
ENDPOINTS:      /stream        — MJPEG multipart stream
                /health        — JSON health / status
                /robot-health  — robot connection status
"""

import sys
import cv2
import time
import threading
import logging
import numpy as np
from flask import Flask, Response, jsonify
from flask_cors import CORS

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CONFIGURATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ROBOT_IP        = "10.10.10.10"   # Niryo default hotspot IP
PORT            = 5001
JPEG_QUALITY    = 80
FPS             = 30
FRAME_INTERVAL  = 1.0 / FPS
FRAME_STALE_SEC = 5               # mark stream stale if no new frame for N s
CONNECT_TIMEOUT = 8               # seconds per TCP connection attempt
MAX_BACKOFF     = 60              # cap exponential reconnect backoff at 60 s

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LOGGING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("niryo-stream")
logging.getLogger("werkzeug").setLevel(logging.ERROR)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PYNIRYO IMPORT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

try:
    from pyniryo import NiryoRobot
    _pyniryo_available = True
    log.info("pyniryo loaded ✔")
except ImportError:
    _pyniryo_available = False
    log.warning("pyniryo not installed — robot camera unavailable")

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SHARED STATE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_lock               = threading.Lock()
_latest_frame       = None
_frame_count        = 0
_start_time         = time.time()
_last_frame_time    = 0.0
_camera_ok          = False
_robot_connected    = False
_reconnect_attempts = 0

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ROBOT CONNECTION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _connect_robot():
    """Try once to connect to the Niryo robot. Returns a NiryoRobot or None."""
    if not _pyniryo_available:
        return None
    try:
        log.info(f"Connecting to robot at {ROBOT_IP} …")
        robot = NiryoRobot(ROBOT_IP)
        log.info("Robot connected ✔")
        return robot
    except Exception as exc:
        log.warning(f"Robot connection failed: {exc}")
        return None

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# FALLBACK FRAME  (shown while robot is offline / reconnecting)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _make_fallback_frame(message="Niryo camera — reconnecting..."):
    h, w = 360, 640
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    frame[:] = (20, 26, 36)
    cv2.rectangle(frame, (2, 2), (w - 3, h - 3), (0, 80, 120), 1)

    cx, cy = w // 2, h // 2 - 30
    cv2.line(frame, (cx - 40, cy), (cx - 10, cy), (0, 120, 180), 2)
    cv2.line(frame, (cx + 10, cy), (cx + 40, cy), (0, 120, 180), 2)
    cv2.circle(frame, (cx, cy), 18, (0, 80, 120), 2)
    cv2.putText(frame, "!", (cx - 6, cy + 6),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 180, 255), 2)

    for i, line in enumerate(message.split(" — ")):
        y = cy + 50 + i * 24
        text_size = cv2.getTextSize(line, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)[0]
        x = (w - text_size[0]) // 2
        cv2.putText(frame, line, (x, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 170, 200), 1)

    ts = time.strftime("%H:%M:%S")
    cv2.putText(frame, f"Niryo {ROBOT_IP}", (10, h - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (80, 100, 120), 1)
    cv2.putText(frame, ts, (w - 70, h - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (80, 100, 120), 1)

    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
    return buf.tobytes()


_FALLBACK_BYTES = _make_fallback_frame()

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ROBOT CAMERA LOOP  (daemon thread)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def camera_loop():
    """
    Connects to the Niryo robot and continuously fetches JPEG frames
    via robot.get_img_compressed(). Reconnects automatically on failure.
    """
    global _latest_frame, _frame_count, _last_frame_time
    global _camera_ok, _robot_connected, _reconnect_attempts

    robot   = None
    backoff = 2.0

    while True:
        # ── Connect / reconnect ──────────────────────────────────
        if robot is None:
            with _lock:
                _reconnect_attempts += 1

            robot = _connect_robot()

            with _lock:
                _robot_connected = robot is not None

            if robot is None:
                fallback = _make_fallback_frame(
                    f"Robot offline — retry in {int(backoff)}s"
                )
                with _lock:
                    _latest_frame = fallback
                    _camera_ok    = False

                log.info(f"Retry in {backoff:.0f}s (attempt #{_reconnect_attempts})")
                time.sleep(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF)
                continue

            backoff = 2.0   # reset on successful connect

        # ── Fetch frame from robot camera ────────────────────────
        try:
            img = robot.get_img_compressed()

            if img is None:
                time.sleep(0.1)
                continue

            np_arr = np.frombuffer(img, np.uint8)
            frame  = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            if frame is None:
                time.sleep(0.1)
                continue

            cv2.putText(
                frame, "NIRYO CAM — LIVE",
                (20, 30), cv2.FONT_HERSHEY_SIMPLEX,
                0.65, (0, 255, 0), 2, cv2.LINE_AA,
            )

            _, buffer = cv2.imencode(
                ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
            )

            with _lock:
                _latest_frame    = buffer.tobytes()
                _frame_count    += 1
                _last_frame_time = time.time()
                _camera_ok       = True
                _robot_connected = True

        except Exception as exc:
            log.warning(f"Frame error: {exc}")
            with _lock:
                _camera_ok       = False
                _robot_connected = False
                _latest_frame    = _make_fallback_frame(
                    f"Robot camera lost — reconnecting…"
                )
            robot = None

        time.sleep(FRAME_INTERVAL)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MJPEG STREAM GENERATOR
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def generate_stream():
    while True:
        with _lock:
            frame = _latest_frame if _latest_frame is not None else _FALLBACK_BYTES

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
        )
        time.sleep(FRAME_INTERVAL)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# FLASK APP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app = Flask(__name__)
CORS(app)


@app.route("/stream")
def stream():
    return Response(
        generate_stream(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/robot-health")
def robot_health():
    with _lock:
        connected = _robot_connected
    return jsonify({
        "robot_connected": connected,
        "status": "online" if connected else "offline",
        "robot_ip": ROBOT_IP,
    })


@app.route("/health")
def health():
    now    = time.time()
    uptime = round(now - _start_time, 1)

    with _lock:
        camera_ok          = _camera_ok
        robot_connected    = _robot_connected
        frame_count        = _frame_count
        reconnect_attempts = _reconnect_attempts
        last_frame_age     = (
            round(now - _last_frame_time, 1) if _last_frame_time else None
        )

    avg_fps      = round(frame_count / max(uptime, 1), 2)
    stream_stale = (last_frame_age is None) or (last_frame_age > FRAME_STALE_SEC)

    camera_status = (
        "ok"      if (camera_ok and not stream_stale) else
        "stale"   if (camera_ok and stream_stale)     else
        "offline"
    )

    return jsonify({
        "status":             "ok" if (camera_ok and not stream_stale) else "degraded",
        "robot_connected":    robot_connected,
        "pyniryo_available":  _pyniryo_available,
        "robot_ip":           ROBOT_IP,
        "camera_connected":   camera_ok,
        "camera_status":      camera_status,
        "uptime_sec":         uptime,
        "frames_captured":    frame_count,
        "avg_fps":            avg_fps,
        "stream_stale":       stream_stale,
        "last_frame_age_sec": last_frame_age,
        "reconnect_attempts": reconnect_attempts,
    })


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# START
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if __name__ == "__main__":
    log.info(
        f"Niryo camera stream server starting on http://0.0.0.0:{PORT}\n"
        f"  Robot IP     : {ROBOT_IP}\n"
        f"  JPEG quality : {JPEG_QUALITY}\n"
        f"  Target FPS   : {FPS}\n"
        f"  Endpoints    : /stream  /health  /robot-health"
    )

    t = threading.Thread(target=camera_loop, daemon=True)
    t.start()

    app.run(host="0.0.0.0", port=PORT, threaded=True)
