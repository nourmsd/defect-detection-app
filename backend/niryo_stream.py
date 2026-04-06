"""
niryo_stream.py
───────────────
MJPEG stream server for the Niryo Ned2 robot camera.
Runs on port 5001.  The Angular dashboard connects via:
    <img src="http://<host>:5001/stream">

Dependencies:
    pip install flask flask-cors opencv-python pyniryo

Start manually:
    python niryo_stream.py

Or let the Node.js backend (server.js) spawn it automatically on startup.

Fix log (v2):
- Robot frame grabbing moved to a background thread (no more blocking the stream)
- Shared frame protected by threading.Lock (no race conditions)
- Explicit ~20 FPS cap via TARGET_FPS to avoid hammering the robot SDK
- Flask served via Waitress (production WSGI) instead of dev server
  → stable multi-client streaming, no more frozen frames
- Placeholder frame regenerated every second while disconnected
- /health endpoint extended with fps + uptime fields
"""

import cv2
import time
import threading
import numpy as np
from flask import Flask, Response, jsonify
from flask_cors import CORS

# ── Try to import pyniryo (only available when robot SDK is installed) ─────────
try:
    from pyniryo2 import NiryoRobot
    try:
        from pyniryo2.vision import uncompress_image
    except ImportError:
        import cv2, numpy as np
        def uncompress_image(compressed):
            np_arr = np.frombuffer(compressed, np.uint8)
            return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    PYNIRYO_AVAILABLE = True
    print("[niryo_stream] pyniryo2 found — will connect to Ned2")
except ImportError:
    PYNIRYO_AVAILABLE = False
    print("[niryo_stream] pyniryo2 not installed — running in placeholder mode")

# ── Config ────────────────────────────────────────────────────────────────────
ROBOT_IP      = "10.10.10.10"   # Niryo Ned2 IP address
STREAM_PORT   = 5001
JPEG_QUALITY  = 80              # 0-100
TARGET_FPS    = 20              # cap frame grab loop; robot SDK can't go faster anyway
RECONNECT_SEC = 5               # seconds between reconnect attempts

app = Flask(__name__)
CORS(app)

# ── Shared state (protected by _lock) ────────────────────────────────────────
_lock          = threading.Lock()
_latest_frame  = None           # bytes: latest JPEG frame
_robot         = None           # NiryoRobot instance or None
_start_time    = time.time()
_frame_count   = 0


# ── Placeholder frame ─────────────────────────────────────────────────────────

def _make_placeholder_frame() -> bytes:
    """Dark 'NO SIGNAL' frame rendered with OpenCV."""
    img = np.zeros((480, 640, 3), dtype=np.uint8)
    img[:] = (13, 19, 33)

    cv2.rectangle(img, (20, 20), (620, 460), (67, 97, 238), 1)

    # Camera icon
    cv2.circle(img, (320, 210), 40, (61, 80, 112), -1)
    cv2.circle(img, (320, 210), 26, (13, 19, 33), -1)
    cv2.rectangle(img, (280, 190), (360, 230), (13, 19, 33), -1)
    cv2.rectangle(img, (274, 198), (366, 232), (61, 80, 112), 2)

    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(img, "CONNECTING TO NIRYO...", (155, 300),
                font, 0.65, (107, 126, 160), 1, cv2.LINE_AA)
    cv2.putText(img, f"Waiting for robot at {ROBOT_IP}", (170, 330),
                font, 0.45, (67, 97, 238), 1, cv2.LINE_AA)
    cv2.putText(img, time.strftime("%H:%M:%S"), (16, 454),
                font, 0.38, (61, 80, 112), 1, cv2.LINE_AA)

    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    return buf.tobytes()


# ── Background capture thread ─────────────────────────────────────────────────

def _capture_loop():
    """
    Runs forever in a daemon thread.
    Grabs frames from the robot (or generates placeholders) and writes them
    to _latest_frame under _lock.  The Flask stream route just reads that
    variable — no blocking I/O inside the HTTP response generator.
    """
    global _robot, _latest_frame, _frame_count

    frame_interval  = 1.0 / TARGET_FPS
    last_attempt    = 0.0

    while True:
        loop_start = time.time()

        # ── (Re)connect if needed ─────────────────────────────────────────
        with _lock:
            robot_ref = _robot

        if robot_ref is None:
            now = time.time()
            if now - last_attempt >= RECONNECT_SEC:
                last_attempt = now
                if PYNIRYO_AVAILABLE:
                    try:
                        r = NiryoRobot(ROBOT_IP)
                        with _lock:
                            _robot = r
                        robot_ref = r
                        print(f"[niryo_stream] Connected to Niryo Ned2 at {ROBOT_IP}")
                    except Exception as e:
                        print(f"[niryo_stream] Cannot connect: {e}")

        # ── Grab frame ────────────────────────────────────────────────────
        if robot_ref is None:
            # Push a fresh placeholder (timestamp ticks every second)
            frame = _make_placeholder_frame()
            with _lock:
                _latest_frame = frame
            time.sleep(1)
            continue

        try:
            img_compressed = robot_ref.vision.get_img_compressed()
            if img_compressed is None:
                time.sleep(0.05)
                continue

            img = uncompress_image(img_compressed)
            _, buf = cv2.imencode('.jpg', img,
                                  [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            frame = buf.tobytes()

            with _lock:
                _latest_frame = frame
                _frame_count += 1

        except Exception as e:
            print(f"[niryo_stream] Frame error: {e} — disconnecting robot")
            with _lock:
                try:
                    _robot.disconnect()
                except Exception:
                    pass
                _robot = None
            time.sleep(2)
            continue

        # ── FPS throttle ──────────────────────────────────────────────────
        elapsed = time.time() - loop_start
        sleep_for = frame_interval - elapsed
        if sleep_for > 0:
            time.sleep(sleep_for)


# ── Flask routes ──────────────────────────────────────────────────────────────

def _generate_mjpeg():
    """
    Generator that reads _latest_frame and yields MJPEG multipart chunks.
    Pure reads under lock — never blocks on I/O.
    """
    while True:
        with _lock:
            frame = _latest_frame

        if frame is None:
            time.sleep(0.05)
            continue

        yield (
            b'--frame\r\n'
            b'Content-Type: image/jpeg\r\n'
            b'Content-Length: ' + str(len(frame)).encode() + b'\r\n'
            b'\r\n' + frame + b'\r\n'
        )

        # Stream at most TARGET_FPS to connected clients
        time.sleep(1.0 / TARGET_FPS)


@app.route('/stream')
def stream():
    """MJPEG stream consumed by the Angular <img> tag."""
    return Response(
        _generate_mjpeg(),
        mimetype='multipart/x-mixed-replace; boundary=frame',
        headers={
            # Prevent any proxy / browser from buffering the stream
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma':        'no-cache',
            'Expires':       '0',
            'X-Accel-Buffering': 'no',   # nginx passthrough
        }
    )


@app.route('/health')
def health():
    with _lock:
        connected = _robot is not None
        frames    = _frame_count
    uptime = round(time.time() - _start_time, 1)
    fps    = round(frames / max(uptime, 1), 1)
    return jsonify({
        'status':            'ok',
        'robot_connected':   connected,
        'pyniryo_available': PYNIRYO_AVAILABLE,
        'robot_ip':          ROBOT_IP,
        'uptime_sec':        uptime,
        'frames_captured':   frames,
        'avg_fps':           fps,
    })


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print(f"[niryo_stream] Starting MJPEG stream server on port {STREAM_PORT}")

    # Start background capture thread (daemon = dies with main process)
    t = threading.Thread(target=_capture_loop, daemon=True)
    t.start()

    # Use Waitress (production WSGI) for stable multi-client streaming.

    try:
        from waitress import serve
        print("[niryo_stream] Using Waitress WSGI server")
        serve(app, host='0.0.0.0', port=STREAM_PORT, threads=8,
              channel_timeout=300)
    except ImportError:
        # Fallback to Flask dev server (single-file usage / quick test)
        print("[niryo_stream] Waitress not found — falling back to Flask dev server")
        print("[niryo_stream]  → run  pip install waitress  for production use")
        app.run(host='0.0.0.0', port=STREAM_PORT, threaded=True)