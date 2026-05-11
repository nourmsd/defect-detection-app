"""
AI module: Flask MJPEG stream server (:5003), FrameGrabber, AI pipelines
(YOLO + TrOCR flavor, ResNet expiry classifier), defect classification, and
the cv2 diagnostics overlay.
"""

import os
import pathlib
import threading
import time
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
from flask import Flask, Response, jsonify
from flask_cors import CORS
from pyzbar import pyzbar

from config import (
    log,
    AI_STREAM_PORT,
    YOLO_CONF_THRESHOLD, YOLO_IOU_THRESHOLD, MAX_DETECTIONS,
    FLAVOR_CLASS_NAME, FLAVOR_CONF, FLAVOR_SCALE, FLAVOR_SAVE_DIR,
    BARCODE_CLASS_NAME, BARCODE_CONF,
    EXPIRY_CLASS_ID, CONFIDENCE_THRESHOLD, EXPIRY_RUNS,
    CLASSIFIER_MODEL_PATH,
    DEBUG_SAVE_CROPS, DEBUG_CROP_DIR,
    IMAGENET_MEAN, IMAGENET_STD, _CLAHE,
)
# ═══════════════════════════════════════════════════════════════════════════════
# SHARED FLASK APPLICATION (AI stream)
# ═══════════════════════════════════════════════════════════════════════════════
ai_app = Flask("ai_stream_server")
CORS(ai_app)
# ═══════════════════════════════════════════════════════════════════════════════
# FRAME GRABBER
# ═══════════════════════════════════════════════════════════════════════════════
class FrameGrabber(threading.Thread):
    """Background thread: always keeps the latest frame.
    Source can be an MJPEG URL ('http://...') or a webcam index ('0', '1', ...
    or an int) — useful for the DroidCam Windows virtual-webcam mode."""

    def __init__(self, source) -> None:
        super().__init__(daemon=True, name="frame-grabber")
        # Accept ints, numeric strings, or full URLs.
        if isinstance(source, int):
            self._source = source
        else:
            s = str(source).strip()
            self._source = int(s) if s.isdigit() else s
        self._url   = str(source)  # human-readable label for logs
        self._lock  = threading.Lock()
        self._frame: Optional[np.ndarray] = None
        self._count = 0
        self._alive = True

    def run(self) -> None:
        backoff = 1.0
        while self._alive:
            cap = None
            try:
                if isinstance(self._source, int):
                    # DSHOW backend is faster + more reliable for virtual webcams on Windows
                    cap = cv2.VideoCapture(self._source, cv2.CAP_DSHOW)
                else:
                    cap = cv2.VideoCapture(self._source)
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


class InProcessFrameGrabber:
    """Drop-in replacement for FrameGrabber that pulls frames directly from
    robot.get_camera_frame_bgr() instead of reading an MJPEG URL. Eliminates the
    second TCP connection to the Niryo arm — there is now only ONE pyniryo
    NiryoRobot object in the whole system, owned by robot.connect_robot()."""

    def __init__(self) -> None:
        # Lazy-import to avoid a circular dependency at module load time.
        import robot as _robot_mod
        self._robot_mod = _robot_mod

    def start(self) -> None:
        # No-op: the real grabber thread lives in robot.py and is started by
        # robot.connect_robot(). Kept as a method so the call sites that use
        # FrameGrabber.start() don't need to change.
        return

    def get_latest(self) -> Optional[Tuple[np.ndarray, int]]:
        return self._robot_mod.get_camera_frame_bgr()

    def stop(self) -> None:
        return
# ═══════════════════════════════════════════════════════════════════════════════
# AI MJPEG STREAM  (:5003/ai_stream)
# ═══════════════════════════════════════════════════════════════════════════════
_ai_frame_lock    = threading.Lock()
_ai_latest_frame: Optional[bytes] = None

# DroidCam barcode stream — annotated phone-camera feed.
_barcode_frame_lock:    threading.Lock         = threading.Lock()
_barcode_latest_frame:  Optional[bytes]        = None


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


@ai_app.route("/barcode_stream")
def _barcode_stream_route():
    """MJPEG of the DroidCam phone camera with YOLO bbox + decoded text overlay.
    Open in a browser tab next to /ai_stream to see both feeds live."""
    def _generate():
        while True:
            with _barcode_frame_lock:
                data = _barcode_latest_frame
            if data is not None:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + data + b"\r\n")
            time.sleep(1.0 / 30.0)
    return Response(_generate(), mimetype="multipart/x-mixed-replace; boundary=frame")


@ai_app.route("/health")
def _ai_health_route():
    return jsonify({
        "status":          "ok",
        "ai_stream":       f"http://0.0.0.0:{AI_STREAM_PORT}/ai_stream",
        "barcode_stream":  f"http://0.0.0.0:{AI_STREAM_PORT}/barcode_stream",
    })


def _publish_mjpeg(vis_frame: np.ndarray) -> None:
    global _ai_latest_frame
    try:
        _, buf = cv2.imencode(".jpg", vis_frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        with _ai_frame_lock:
            _ai_latest_frame = buf.tobytes()
    except Exception:
        pass


def _publish_barcode_mjpeg(vis_frame: np.ndarray) -> None:
    """Push a JPEG of the DroidCam barcode-camera frame (annotated with YOLO
    bbox + decoded text) onto /barcode_stream."""
    global _barcode_latest_frame
    try:
        _, buf = cv2.imencode(".jpg", vis_frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        with _barcode_frame_lock:
            _barcode_latest_frame = buf.tobytes()
    except Exception:
        pass


# [BARCODE DISABLED] — compose_combined_view stub (original body kept as a docstring)
def _compose_combined_view_DISABLED(ai_view, target_w=1920, target_h=1080):
    """Disabled along with the rest of the barcode pipeline. Original body:

    with _barcode_view_lock:
        bc_view = _barcode_view_latest
    if bc_view is None:
        bc_view = np.full((360, 640, 3), (15, 18, 24), dtype=np.uint8)
        cv2.putText(bc_view, "BARCODE STREAM STARTING...", (40, 190),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 165, 255), 2, cv2.LINE_AA)
    ...   (50/50 letterbox compose, see git history)
    """
    return None


def _start_ai_stream_server() -> None:
    ai_app.run(host="0.0.0.0", port=AI_STREAM_PORT, threaded=True)


# [BARCODE DISABLED] — build_barcode_display stub (original body kept as a docstring)
def _build_barcode_display_DISABLED(frame, bc_text, bc_type, bc_bbox, fps):
    """Disabled along with the rest of the barcode pipeline. Original body:

    Annotated DroidCam frame with bbox + decoded barcode text. Drew corner
    brackets, pill labels, header/footer strips. See git history for the full
    implementation; reactivate by uncommenting the block tagged
    [BARCODE DISABLED] in this file.
    """
    return None


def _publish_splash(status: str, detail: str = "") -> None:
    """Render a placeholder diagnostics frame so /ai_stream has something to serve
    before the state machine produces its first real annotated frame."""
    panel_w = globals().get("_PANEL_W", 340)
    h, w = 540, 960 + panel_w
    frame = np.full((h, w, 3), (12, 16, 24), dtype=np.uint8)
    cv2.putText(frame, "AI PIPELINE", (40, 80),
                cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 210, 210), 3, cv2.LINE_AA)
    cv2.putText(frame, status, (40, 150),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (240, 240, 240), 2, cv2.LINE_AA)
    if detail:
        for i, line in enumerate(detail.split("\n")):
            cv2.putText(frame, line, (40, 200 + i * 32),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (160, 160, 160), 1, cv2.LINE_AA)
    cv2.putText(frame, datetime.now().strftime("%H:%M:%S"), (w - 140, h - 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (110, 110, 110), 1, cv2.LINE_AA)
    _publish_mjpeg(frame)


# ═══════════════════════════════════════════════════════════════════════════════
# EXPIRY-DATE PARSING & DEFECT CLASSIFICATION
# ═══════════════════════════════════════════════════════════════════════════════

_MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]


def _parse_expiry_date(text: Optional[str]) -> Optional[Tuple[int, int]]:
    """Parse a 'DD MMM' expiry-date string (e.g. '12 JAN') into (month_index, day),
    1-indexed month. Returns None on any parse failure."""
    if not text:
        return None
    parts = text.strip().upper().split()
    if len(parts) != 2:
        return None
    try:
        day = int(parts[0])
    except ValueError:
        return None
    mon = parts[1][:3]
    if mon not in _MONTHS:
        return None
    return (_MONTHS.index(mon) + 1, day)


BLANK_CROP_STD_THRESHOLD  = 18.0   # grayscale std below this → unicolor flat sticker
BLANK_CROP_EDGE_THRESHOLD = 0.035  # high-threshold edge-pixel ratio below this → no print


def _crop_is_blank(crop_bgr: Optional[np.ndarray]) -> bool:
    if crop_bgr is None or crop_bgr.size == 0:
        return False
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    if float(gray.std()) < BLANK_CROP_STD_THRESHOLD:
        return True
    edges = cv2.Canny(gray, 100, 200)
    edge_density = float(np.count_nonzero(edges)) / float(edges.size)
    return edge_density < BLANK_CROP_EDGE_THRESHOLD


def _classify_defect(
    expiry_outputs: List[Dict],
    detected_date:  Optional[str],
) -> Optional[str]:
    # Late import to avoid circular dependency: robot.py imports ai (for splash etc.)
    # — but actually ai is independent of robot. We need _reference_date which lives
    # in robot.py. Import at call-time.
    import robot as _robot_mod

    if not expiry_outputs:
        return "absent"
    if all(e.get("is_blank") for e in expiry_outputs):
        return "absent"
    has_readable = any(
        e["status"] == "NORMAL" and e.get("text") for e in expiry_outputs
    )
    if not has_readable:
        return "blurry"
    with _robot_mod._reference_date_lock:
        ref = _robot_mod._reference_date
    ref_parsed = _parse_expiry_date(ref) if ref else None
    det_parsed = _parse_expiry_date(detected_date)
    if ref_parsed and det_parsed and det_parsed < ref_parsed:
        return "expired"
    return None


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
# PIPELINE C — BARCODE  (YOLO → pyzbar, on the robot camera frame)
# ═══════════════════════════════════════════════════════════════════════════════

BARCODE_UPSCALE = 3.0   # how much to enlarge the crop before decoding


def _enhance_for_barcode(crop_bgr: np.ndarray) -> List[Tuple[str, np.ndarray]]:
    """Build several preprocessed variants of a low-res barcode crop, ordered
    from lightest to most aggressive. pyzbar prefers different forms depending
    on lighting — first one that decodes wins.

    Why each step matters with the Niryo's low-res camera:
      • Upscale 3× (cubic) — pyzbar's edge-detector needs crisp transitions; a
        ~30-pixel-wide barcode rarely decodes natively.
      • CLAHE — flattens uneven illumination from the gripper-mounted camera.
      • Unsharp-mask — restores edge sharpness lost by the cubic upscale.
      • Otsu — global binarisation; works well when contrast is uniform.
      • Adaptive — local binarisation; handles glare / shadows on the cap.
    """
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    up = cv2.resize(gray,
                    (max(1, int(w * BARCODE_UPSCALE)), max(1, int(h * BARCODE_UPSCALE))),
                    interpolation=cv2.INTER_CUBIC)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    up_clahe = clahe.apply(up)
    blurred  = cv2.GaussianBlur(up_clahe, (0, 0), sigmaX=1.5)
    sharp    = cv2.addWeighted(up_clahe, 1.6, blurred, -0.6, 0)
    _, otsu  = cv2.threshold(sharp, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    adapt    = cv2.adaptiveThreshold(sharp, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                     cv2.THRESH_BINARY, 21, 6)
    return [("upscaled", up),
            ("clahe",    up_clahe),
            ("sharp",    sharp),
            ("otsu",     otsu),
            ("adaptive", adapt)]


def run_barcode_pipeline(
    frame: np.ndarray,
    yolo:  YOLO,
) -> Tuple[Optional[str], Optional[str], Optional[Tuple[int,int,int,int]], Optional[np.ndarray]]:
    """Locate barcode via YOLO, then aggressively enhance the crop and try
    pyzbar across multiple variants × rotations. The Niryo's gripper-camera is
    low-res, so the raw crop almost never decodes — preprocessing is essential.

    Returns (barcode_data, barcode_type, bbox, enhanced_preview):
      barcode_data       — decoded text, None if no decode
      barcode_type       — symbology (EAN13, CODE128, QR…)
      bbox               — original-frame bbox used for overlay
      enhanced_preview   — sharp grayscale variant of the crop (for the
                           diagnostics panel thumbnail). Always set when a
                           bbox was found, even if decoding failed.
    """
    results = yolo(frame, verbose=False, conf=BARCODE_CONF)[0]
    if results.boxes is None:
        return None, None, None, None

    h, w = frame.shape[:2]
    last_preview: Optional[np.ndarray] = None
    for box in results.boxes:
        if yolo.names[int(box.cls)] != BARCODE_CLASS_NAME:
            continue
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        # Asymmetric crop expansion. pyzbar needs a "quiet zone" (white margin)
        # of ~10× the narrowest bar width on the side the bars *end* at — i.e.
        # in the direction perpendicular to the bars. We don't know the bar
        # orientation in advance, so we pick by aspect ratio:
        #   bbox wider than tall  → bars are horizontal → extend Y much more
        #   bbox taller than wide → bars are vertical   → extend X much more
        # Either way, the bar-PARALLEL axis just needs a small pad to capture
        # any edge bars YOLO clipped off; the bar-PERPENDICULAR axis needs a
        # generous quiet zone so pyzbar can lock onto start/stop guards.
        bw, bh = (x2 - x1), (y2 - y1)
        if bw >= bh:
            pad_x = max(8,  int(bw * 0.10))   # bars horizontal: minor X pad
            pad_y = max(30, int(bh * 1.50))   # generous Y quiet zone
        else:
            pad_x = max(30, int(bw * 1.50))   # bars vertical: generous X quiet zone
            pad_y = max(8,  int(bh * 0.10))   # minor Y pad
        cx1, cy1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
        cx2, cy2 = min(w - 1, x2 + pad_x), min(h - 1, y2 + pad_y)
        crop = frame[cy1:cy2, cx1:cx2]
        if crop.size == 0:
            continue

        variants = _enhance_for_barcode(crop)
        # Use the "sharp" variant as the preview thumbnail shown in the panel.
        last_preview = next((v for n, v in variants if n == "sharp"), variants[0][1])

        # Try every (variant × rotation) combination — first decode wins.
        rotations = [(None, "0°"),
                     (cv2.ROTATE_90_CLOCKWISE, "90°"),
                     (cv2.ROTATE_180,          "180°"),
                     (cv2.ROTATE_90_COUNTERCLOCKWISE, "270°")]
        for var_name, var_img in variants:
            for rot, rot_label in rotations:
                img = var_img if rot is None else cv2.rotate(var_img, rot)
                try:
                    decoded = pyzbar.decode(img)
                except Exception as exc:
                    log.debug(f"[BARCODE] decode error ({var_name}/{rot_label}): {exc}")
                    continue
                if decoded:
                    d = decoded[0]
                    text = d.data.decode("utf-8", errors="replace")
                    btype = d.type
                    log.info(
                        f"[BARCODE] YOLO={float(box.conf[0]):.2f} | "
                        f"decoded via [{var_name}/{rot_label}] → {btype}: {text!r}"
                    )
                    return text, btype, (x1, y1, x2, y2), last_preview
        log.debug(
            f"[BARCODE] YOLO bbox at ({x1},{y1})-({x2},{y2}) found but no "
            f"variant×rotation decoded after {len(variants)*len(rotations)} attempts."
        )
        # Even on failure, return the bbox + preview so the operator can see
        # the system is trying — the dashboard will still show the thumbnail.
        return None, None, (x1, y1, x2, y2), last_preview

    return None, None, None, None


# ═══════════════════════════════════════════════════════════════════════════════
# PIPELINE B — EXPIRY DATE  (YOLO → ResNet multi-head classifier)
# ═══════════════════════════════════════════════════════════════════════════════

_debug_crop_counter = 0


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
            "is_blank":          _crop_is_blank(crop),
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
    barcode_text:    Optional[str]                    = None
    barcode_type:    Optional[str]                    = None
    barcode_bbox:    Optional[Tuple[int,int,int,int]] = None
    barcode_preview: Optional[np.ndarray]             = None  # enhanced grayscale crop (sharp variant) shown in panel
    done:           bool                             = False
    aborted:        bool                             = False  # operator removed the product
    t_start:        float                            = field(default_factory=time.perf_counter)
    # Final classification — set by app.py after the gather loop completes.
    final_label:    Optional[str]                    = None   # "ok" / "defective"
    defect_type:    Optional[str]                    = None   # "absent" / "blurry" / "expired" / None


# ═══════════════════════════════════════════════════════════════════════════════
# AI DIAGNOSTICS DISPLAY
# ═══════════════════════════════════════════════════════════════════════════════

_COLOR_VALID   = (96, 220, 120)   # mint green
_COLOR_DEFECT  = (76, 76, 235)    # crimson
_COLOR_WARNING = (60, 180, 240)   # amber
_COLOR_FLAVOR  = (255, 200, 80)   # cyan-amber
_COLOR_BARCODE = (255, 200, 0)    # gold
_PANEL_W       = 340
_PANEL_BG      = (15, 20, 30)


def _draw_corner_bbox(img: np.ndarray, x1: int, y1: int, x2: int, y2: int,
                      color: Tuple[int,int,int], thickness: int = 2,
                      arm_ratio: float = 0.18) -> None:
    """Industrial-style bbox: only the four corners drawn, with thin guide lines.
    Looks much cleaner than a full rectangle."""
    arm = max(8, int(min(x2 - x1, y2 - y1) * arm_ratio))
    # Faint full rectangle (1px) for context
    overlay = img.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), color, 1, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.35, img, 0.65, 0, dst=img)
    # Solid corner brackets
    for (cx, cy, dx, dy) in [
        (x1, y1, +1, +1), (x2, y1, -1, +1),
        (x1, y2, +1, -1), (x2, y2, -1, -1),
    ]:
        cv2.line(img, (cx, cy), (cx + dx*arm, cy), color, thickness, cv2.LINE_AA)
        cv2.line(img, (cx, cy), (cx, cy + dy*arm), color, thickness, cv2.LINE_AA)


def _draw_label_pill(img: np.ndarray, text: str, x: int, y: int,
                     color: Tuple[int,int,int],
                     scale: float = 0.5, pad: int = 6) -> None:
    """Translucent rounded label box with text on top. Anchored bottom-left at (x, y)."""
    if not text:
        return
    (tw, th), bl = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)
    x = max(2, x); y = max(th + pad, y)
    x1, y1 = x, y - th - pad
    x2, y2 = x + tw + 2*pad, y + bl
    overlay = img.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), (15, 18, 24), -1, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.78, img, 0.22, 0, dst=img)
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 1, cv2.LINE_AA)
    cv2.putText(img, text, (x + pad, y - 2),
                cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


# [BARCODE DISABLED] — _draw_barcode_pip stub (original body kept as a docstring)
def _draw_barcode_pip_DISABLED(main, bc_frame, bc_bbox, bc_text):
    """Disabled. Drew a small DroidCam PIP in the top-right corner of the main
    frame with the barcode bbox + decoded caption. See git history to restore.
    """
    return None


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
    # Local import of MAX_SCAN_ATTEMPTS / PRESENCE_SETTLE_SECS for state labels
    from config import MAX_SCAN_ATTEMPTS, PRESENCE_SETTLE_SECS

    main = base_frame.copy()
    h, w = main.shape[:2];  pad = 7

    if result.flavor_bbox and result.flavor_text:
        x1, y1, x2, y2 = result.flavor_bbox
        _draw_corner_bbox(main, x1, y1, x2, y2, _COLOR_FLAVOR, thickness=2)
        _draw_label_pill(main, f"FLAVOR  {result.flavor_text}",
                         x1, max(20, y1 - 6), _COLOR_FLAVOR, scale=0.50)

    for det in result.expiry_outputs:
        x1, y1, x2, y2 = det["crop_bbox"];  status = det["status"]
        if status == "NORMAL":     color, lbl = _COLOR_VALID,   f"DATE  {det['text']}"
        elif status == "DEFECTIVE": color, lbl = _COLOR_DEFECT,  "DATE  unreadable"
        else:                       color, lbl = _COLOR_WARNING, f"DATE  ? {det['text']}"
        _draw_corner_bbox(main, x1, y1, x2, y2, color, thickness=2)
        _draw_label_pill(main, lbl, x1, max(20, y1 - 6), color, scale=0.50)

    # Barcode bbox + decoded text (drawn on the same robot-camera frame).
    if result.barcode_bbox and result.barcode_text:
        x1, y1, x2, y2 = result.barcode_bbox
        _draw_corner_bbox(main, x1, y1, x2, y2, _COLOR_BARCODE, thickness=2)
        bc_lbl = f"BARCODE  {result.barcode_text}"
        _draw_label_pill(main, bc_lbl, x1, max(20, y1 - 6), _COLOR_BARCODE, scale=0.50)

    fps_lbl = f"FPS {fps:.1f}"
    (tw, _), _ = cv2.getTextSize(fps_lbl, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2)
    cv2.putText(main, fps_lbl, (w-tw-10, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0,255,255), 2, cv2.LINE_AA)

    if state == "SCANNING":
        bar_full = int(presence_frac * (w - 20))
        cv2.rectangle(main, (10,h-18), (10+bar_full,h-8), (0,200,255), -1)
        attempts_lbl = f"  [attempt {scan_attempts}/{MAX_SCAN_ATTEMPTS}]" if scan_attempts > 0 else ""
        secs_left = max(0.0, PRESENCE_SETTLE_SECS * (1.0 - presence_frac))
        cv2.putText(main, f"SCANNING — hold steady ({secs_left:.1f}s){attempts_lbl}",
                    (10,30), cv2.FONT_HERSHEY_SIMPLEX, 0.60, (0,200,255), 2, cv2.LINE_AA)
    elif state == "PROCESSING":
        cv2.putText(main, "PROCESSING ...", (10,30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255,180,0), 2, cv2.LINE_AA)
    elif state == "WAITING_REMOVAL":
        bar_full = int(presence_frac * (w - 20))
        cv2.rectangle(main, (10,h-18), (10+bar_full,h-8), (180,180,180), -1)
        cv2.putText(main, f"WAITING FOR PRODUCT REMOVAL ({int(presence_frac*100)}%)",
                    (10,30), cv2.FONT_HERSHEY_SIMPLEX, 0.60, (200,200,200), 2, cv2.LINE_AA)
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
    # Final classification banner (only set once gather completes)
    if result.final_label is not None:
        is_ok = result.final_label == "ok"
        verdict_color = _COLOR_VALID if is_ok else _COLOR_DEFECT
        verdict_txt   = "CONFORMING" if is_ok else "DEFECTIVE"
        cv2.putText(panel, f"VERDICT: {verdict_txt}", (pad, 58),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.46, verdict_color, 1, cv2.LINE_AA)
        if not is_ok and result.defect_type:
            defect_map = {
                "absent":  "no date detected",
                "blurry":  "date unreadable",
                "expired": "past expiry",
            }
            sub = defect_map.get(result.defect_type, result.defect_type)
            cv2.putText(panel, f"  {result.defect_type.upper()} — {sub}", (pad, 74),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, _COLOR_DEFECT, 1, cv2.LINE_AA)
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

    cv2.putText(panel, "BARCODE", (pad,py),
                cv2.FONT_HERSHEY_SIMPLEX, 0.44, _COLOR_BARCODE, 1, cv2.LINE_AA)
    py += 15
    bc_disp = result.barcode_text or ("undecoded" if result.barcode_bbox else "not detected")
    if result.barcode_text and result.barcode_type:
        bc_disp = f"{result.barcode_type}: {result.barcode_text}"
    bc_color = _COLOR_BARCODE if result.barcode_text else \
               (_COLOR_WARNING if result.barcode_bbox else (80,80,80))
    cv2.putText(panel, f"  {bc_disp}", (pad,py), cv2.FONT_HERSHEY_SIMPLEX, 0.42,
                bc_color, 1, cv2.LINE_AA)
    py += 14

    # Barcode crop thumbnail removed — the decoded number above is the
    # operator-relevant signal. The DroidCam side stream still shows the
    # live YOLO bbox for debugging if needed.

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
