"""
Configuration: env vars, constants, model paths, Cartesian poses, logger.
No mutable runtime state, no Flask apps.
"""

import os
import logging
import threading  # noqa: F401  (re-used downstream)

import cv2
import numpy as np

# Re-export PoseObject so the pose constants below can be used directly.
from pyniryo import PoseObject  # noqa: F401


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
# The standalone cv2 desktop window ("Yogurt Inspection — AI Diagnostics") is
# disabled in production. The same composited frame is still published to
# :5003/ai_stream and consumed by the worker dashboard's AI DIAGNOSIS panel,
# so the operator-facing view stays unchanged. Set to True only when debugging
# the AI pipeline directly on the line PC (e.g. checking why YOLO is missing
# the barcode without having to open the browser).
SHOW_DEBUG_WINDOW   = False
DISPLAY_WINDOW_NAME = "Yogurt Inspection — AI Diagnostics"

# ── State machine ─────────────────────────────────────────────────────────────
PRESENCE_FRAMES   = 5     # min YOLO-detected frames (anti-flicker floor)
PRESENCE_SETTLE_SECS = 3.0  # seconds of continuous presence required before AI fires
ABSENCE_FRAMES    = 8     # consecutive empty frames → product gone → re-arm scanning
RESULT_HOLD_SECS  = 4.0   # seconds to hold RESULT state before resetting
MAX_SCAN_ATTEMPTS = 3     # failed scans with no valid date before forcing DEFECTIVE

# ── Robot watchdog ────────────────────────────────────────────────────────────
ROBOT_CHECK_INTERVAL_S = 5.0
ROBOT_WAIT_TIMEOUT_S   = 30.0   # fail fast — 30s max wait in industrial real-time context
ROBOT_RETRY_WAIT_S     = 2.0    # retry every 2s

# ── Robot motion ──────────────────────────────────────────────────────────────
CONNECT_TIMEOUT_S  = 10
MOVE_SPEED         = 60    # joint speed percentage (1–100)
GRIPPER_SPEED      = 400   # open/close speed (0–1000)
GRIPPER_HOLD_MS    = 600   # ms to hold after grasp
GRIPPER_RELEASE_MS = 400   # ms to hold after release
POLL_INTERVAL_S    = 0.5   # worker queue poll interval

# ── Model paths ───────────────────────────────────────────────────────────────
_AI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai")
if not os.path.exists(os.path.join(_AI_DIR, "yog_yolo26n.pt")):
    # In git worktrees model files (gitignored) live in the main checkout:
    # <project>/.claude/worktrees/<name>/backend/  →  4 levels up  →  <project>/backend/ai
    _worktree_fallback = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "backend", "ai")
    )
    if os.path.exists(os.path.join(_worktree_fallback, "yog_yolo26n.pt")):
        _AI_DIR = _worktree_fallback
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

# ── Pipeline C — Barcode (YOLO + pyzbar, sourced from a DroidCam phone) ────
# The Niryo's gripper camera looks straight down and cannot resolve barcodes
# wrapped on the cup wall, so we use a phone running DroidCam pointed at the
# cup's side as a dedicated barcode camera. Set DROIDCAM_URL to the phone's
# DroidCam server URL (Settings → check the IP/port shown in the app).
DROIDCAM_URL       = os.environ.get("DROIDCAM_URL", "http://10.10.10.115:4747/video")
BARCODE_CLASS_NAME = "barcode"
BARCODE_CONF       = 0.30

# # ── PLC (Siemens via Snap7) ──────────────────────────────────────────────────
# PLC_IP        = os.environ.get("PLC_IP", "192.168.0.1")
# PLC_DB_NUMBER = int(os.environ.get("PLC_DB_NUMBER", "1"))
# PLC_RACK      = int(os.environ.get("PLC_RACK", "0"))
# PLC_SLOT      = int(os.environ.get("PLC_SLOT", "1"))
# Bit offsets inside DB1.DBX0.x — change to match your TIA project
# PLC_BIT_CONFORM   = int(os.environ.get("PLC_BIT_CONFORM",   "0"))   # advance conveyor
# PLC_BIT_DEFECTIVE = int(os.environ.get("PLC_BIT_DEFECTIVE", "1"))   # optional reject signal

# _plc_client = snap7.client.Client() if _SNAP7_AVAILABLE else None
# _plc_lock   = threading.Lock()


# def plc_send_command(offset_bit: int) -> None:
#     """Set DB<PLC_DB_NUMBER>.DBX0.<offset_bit> high. Lazy connects on first use,
#     serialises calls behind a lock, and silently no-ops if snap7 is missing."""
#     if not _SNAP7_AVAILABLE or _plc_client is None:
#         log.warning(f"[PLC] snap7 not installed — skipping bit 0.{offset_bit}")
#         return
#     with _plc_lock:
#         try:
#             if not _plc_client.get_connected():
#                 _plc_client.connect(PLC_IP, PLC_RACK, PLC_SLOT)
#             data = _plc_client.db_read(PLC_DB_NUMBER, 0, 1)
#             set_bool(data, 0, offset_bit, True)
#             _plc_client.db_write(PLC_DB_NUMBER, 0, data)
#             log.info(f"[PLC] Set DB{PLC_DB_NUMBER}.DBX0.{offset_bit} = TRUE")
#         except Exception as exc:
#             log.warning(f"[PLC] Communication error on bit 0.{offset_bit}: {exc}")


# ── Pipeline B — Expiry date (ResNet multi-head classifier) ──────────────────
EXPIRY_CLASS_ID      = 1
CONFIDENCE_THRESHOLD = 0.45   # minimum overall_conf to trust a single run
EXPIRY_RUNS          = 1      # single-shot — no vote, first read decides

# ── Debug crops ───────────────────────────────────────────────────────────────
DEBUG_SAVE_CROPS    = True
DEBUG_CROP_DIR      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug_crops")

# ── ImageNet normalisation ────────────────────────────────────────────────────
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
IMAGENET_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)
_CLAHE        = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))


# ═══════════════════════════════════════════════════════════════════════════════
# CARTESIAN POSES  (x/y/z metres, roll/pitch/yaw radians)
# ═══════════════════════════════════════════════════════════════════════════════
# Using PoseObject + move_pose instead of joint arrays + move_joints because
# this combination has been verified to work end-to-end on the production arm.

INSPECTION_POSE = PoseObject(x=0.244, y=0.022, z=0.191,
                             roll=-2.796, pitch=1.463, yaw=-2.891)
PICK_POSE       = PoseObject(x=0.295, y=0.05,  z=0.137,
                             roll=-3.036, pitch=1.525, yaw=-3.087)
INTER_POSE1     = PoseObject(x=0.228, y=0.039, z=0.241,
                             roll= 2.916, pitch=1.505, yaw= 2.951)
INTER_POSE2     = PoseObject(x=-0.004,y=0.255, z=0.285,
                             roll=-0.43,  pitch=1.428, yaw= 1.082)
REJECT_BIN_POSE = PoseObject(x=-0.036,y=0.365, z=0.177,
                             roll=-0.055, pitch=1.407, yaw= 1.521)
