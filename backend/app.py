import json
import threading
import time
import uuid
import queue as queue_module
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
import torch.nn as nn
from ultralytics import YOLO

import config
from config import (
    log,
    NIRYO_STREAM_URL, NIRYO_HEALTH_URL,
    AI_STREAM_PORT,
    ROBOT_IP, ROBOT_SERVICE_PORT,
    YOLO_MODEL_PATH, FLAVOR_MODEL_PATH, CLASSIFIER_MODEL_PATH,
    YOLO_CONF_THRESHOLD,
    PRESENCE_FRAMES, PRESENCE_SETTLE_SECS, ABSENCE_FRAMES, RESULT_HOLD_SECS,
    MAX_SCAN_ATTEMPTS,
    ROBOT_CHECK_INTERVAL_S, ROBOT_WAIT_TIMEOUT_S, ROBOT_RETRY_WAIT_S,
    EXPIRY_RUNS, MOVE_SPEED,
    SHOW_DEBUG_WINDOW, DISPLAY_WINDOW_NAME,
    DROIDCAM_URL, BARCODE_CLASS_NAME, BARCODE_CONF,
    PIPELINE_EVENT_PREFIX,
    plc_send_command,
    PLC_BIT_CONFORM,
    PLC_BIT_DEFECTIVE,
    _plc_client
)

import robot   
import ai
from ai import (
    FrameGrabber,
    InProcessFrameGrabber,
    TrOCRReader,
    InspectionResult,
    run_flavor_pipeline,
    run_expiry_pipeline,
    run_barcode_pipeline,
    load_expiry_models,
    build_display,
    _classify_defect,
    _publish_mjpeg,
    _publish_barcode_mjpeg,
    _publish_splash,
    _start_ai_stream_server,
    _COLOR_BARCODE,
    _draw_corner_bbox,
    _draw_label_pill,
)

def _print_startup_banner() -> None:
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


def _start_background_services() -> None:
    threading.Thread(target=_start_ai_stream_server,         daemon=True, name="ai-stream").start()
    threading.Thread(target=robot._start_robot_http_server,  daemon=True, name="robot-http").start()
    threading.Thread(target=robot._start_stream_http_server, daemon=True, name="stream-http").start()
    threading.Thread(target=robot.worker_loop,               daemon=True, name="robot-worker").start()
    log.info(f"[INIT] AI stream        → http://0.0.0.0:{AI_STREAM_PORT}/ai_stream")
    log.info(f"[INIT] Robot API        → http://0.0.0.0:{ROBOT_SERVICE_PORT}")
    log.info(f"[INIT] Raw camera       → http://0.0.0.0:{robot.STREAM_SERVICE_PORT}/stream")
    _publish_splash("Booting …", "AI pipeline starting.\nLoading models.This may take a moment.")


def _load_all_models() -> Tuple[YOLO, "TrOCRReader", nn.Module, Dict, torch.device]:
    log.info("[INIT] Loading shared YOLO model …")
    _publish_splash("Loading YOLO detector …", YOLO_MODEL_PATH)
    yolo = YOLO(YOLO_MODEL_PATH)

    log.info("[INIT] Loading Pipeline A: TrOCR flavor reader …")
    _publish_splash("Loading TrOCR (flavor reader) …", FLAVOR_MODEL_PATH)
    ocr_reader = TrOCRReader(FLAVOR_MODEL_PATH)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    log.info(f"[INIT] Loading Pipeline B: expiry classifier on {device} …")
    _publish_splash(f"Loading expiry classifier ({device}) …", CLASSIFIER_MODEL_PATH)
    classifier, expiry_meta = load_expiry_models(device)
    _publish_splash("Models loaded successfully", "Waiting for niryo_stream …")
    return yolo, ocr_reader, classifier, expiry_meta, device


def _start_frame_grabber() -> InProcessFrameGrabber:
    grabber = InProcessFrameGrabber()
    _publish_splash("Waiting for first camera frame …", "robot.get_img_compressed()")
    t0 = time.perf_counter()
    while grabber.get_latest() is None:
        if time.perf_counter() - t0 > 15.0:
            raise RuntimeError("No frame from robot camera within 15s — is the arm cable OK?")
        time.sleep(0.1)
    log.info("[INIT] First frame received — state machine starting.")
    return grabber

def main() -> None:
    _print_startup_banner()
    _start_background_services()
    yolo, ocr_reader, classifier, expiry_meta, device = _load_all_models()
    robot.connect_robot()
    robot._emit_pipeline_state("RUNNING", "Robot connected: AI pipeline fully active")
    grabber = _start_frame_grabber()

    log.info(f"[INIT] Starting DroidCam grabber → {DROIDCAM_URL}")
    barcode_grabber = FrameGrabber(DROIDCAM_URL)
    barcode_grabber.start()
    log.info(f"[INIT] Barcode stream    → http://0.0.0.0:{AI_STREAM_PORT}/barcode_stream")

    _barcode_display_alive = {"v": True}
    _last_decoded = {"text": None, "type": None, "bbox": None, "ts": 0.0}
    _last_decoded_lock = threading.Lock()

    def _barcode_display_loop():
        period = 1.0 / 15.0
        prev_count = -1
        while _barcode_display_alive["v"]:
            t0 = time.perf_counter()
            latest = barcode_grabber.get_latest()
            if latest is None:
                time.sleep(0.1)
                continue
            frame, count = latest
            if count == prev_count:
                time.sleep(period)
                continue
            prev_count = count

            vis = frame.copy()
            try:
                results = yolo(frame, verbose=False, conf=BARCODE_CONF)[0]
                if results.boxes is not None:
                    for box in results.boxes:
                        if yolo.names[int(box.cls)] != BARCODE_CLASS_NAME:
                            continue
                        x1, y1, x2, y2 = map(int, box.xyxy[0])
                        _draw_corner_bbox(vis, x1, y1, x2, y2, _COLOR_BARCODE, thickness=2)
                with _last_decoded_lock:
                    text = _last_decoded["text"]
                    btype = _last_decoded["type"]
                    age = time.time() - _last_decoded["ts"]
                if text and age < 6.0:
                    label = f"{btype}: {text}" if btype else text
                    _draw_label_pill(vis, label, 12, 30, _COLOR_BARCODE, scale=0.6)
            except Exception as exc:
                log.debug(f"[barcode-display] overlay failed: {exc}")

            _publish_barcode_mjpeg(vis)
            elapsed = time.perf_counter() - t0
            if elapsed < period:
                time.sleep(period - elapsed)

    threading.Thread(target=_barcode_display_loop, daemon=True,
                     name="barcode-display").start()
    _pending_bc_slot:    Dict[str, Optional[str]] = {"text": None, "type": None}
    _pending_bc_lock:    threading.Lock           = threading.Lock()
    _bc_prescan_state: Dict[str, Optional[object]] = {
        "last_decoded":  None,
        "idle":          False,
        "absent_streak": 0,
    }

    def _emit_pipeline_event(event_type: str, payload: Dict) -> None:
        try:
            print(
                f"{PIPELINE_EVENT_PREFIX}"
                f"{json.dumps({'type': event_type, 'payload': payload}, ensure_ascii=False)}",
                flush=True,
            )
        except Exception as exc:
            log.warning(f"[event] emit {event_type} failed: {exc}")

    def _set_pending_barcode(text: str, btype: Optional[str]) -> None:
        nowiso = datetime.now().astimezone().isoformat()
        with _pending_bc_lock:
            _pending_bc_slot["text"] = text
            _pending_bc_slot["type"] = btype
        ai.set_prescan_barcode(text, btype)
        _emit_pipeline_event("pending_barcode", {
            "barcode": text,
            "barcode_type": btype or "",
            "timestamp": nowiso,
            "status": "waiting_ai",
        })
        log.info(f"[pending-barcode] captured {btype}: {text!r} : waiting for AI inspection")

    def _clear_pending_barcode(reason: str = "consumed") -> None:
        with _pending_bc_lock:
            had = _pending_bc_slot["text"]
            _pending_bc_slot["text"] = None
            _pending_bc_slot["type"] = None
        ai.set_prescan_barcode(None, None)
        _bc_prescan_state["last_decoded"]  = None
        _bc_prescan_state["idle"]          = False
        _bc_prescan_state["absent_streak"] = 0
        if had:
            _emit_pipeline_event("pending_barcode_cleared", {
                "reason": reason,
                "timestamp": datetime.now().astimezone().isoformat(),
            })
            log.info(f"[pending-barcode] cleared ({reason}): was {had!r} — prescan re-armed")

    def _peek_pending_barcode() -> Tuple[Optional[str], Optional[str]]:
        with _pending_bc_lock:
            return _pending_bc_slot["text"], _pending_bc_slot["type"]

    _prescan_alive = {"v": True}

    def _barcode_prescan_loop():
        ARMED_PERIOD            = 0.5    
        IDLE_PERIOD             = 1.5    
        ABSENT_FRAMES_THRESHOLD = 8      

        while _prescan_alive["v"]:
            if _bc_prescan_state["idle"]:
                time.sleep(IDLE_PERIOD)
                continue

            t0 = time.perf_counter()
            latest = barcode_grabber.get_latest()
            if latest is None:
                time.sleep(0.5)
                continue
            frame, _ = latest

            try:
                text, btype, bbox, _ = run_barcode_pipeline(frame, yolo)
            except Exception as exc:
                log.debug(f"[barcode-prescan] decode error: {exc}")
                text, btype, bbox = None, None, None

            if text and text != _bc_prescan_state["last_decoded"]:
                _bc_prescan_state["last_decoded"]  = text
                _bc_prescan_state["absent_streak"] = 0
                _set_pending_barcode(text, btype)
            elif _pending_bc_slot["text"] is not None:
                if bbox is None:
                    _bc_prescan_state["absent_streak"] = int(
                        _bc_prescan_state["absent_streak"]) + 1
                    if int(_bc_prescan_state["absent_streak"]) >= ABSENT_FRAMES_THRESHOLD:
                        _bc_prescan_state["idle"] = True
                        log.info(
                            f"[pending-barcode] phone-cam idle after "
                            f"{ABSENT_FRAMES_THRESHOLD} absent frames — pausing "
                            f"prescan, waiting for AI to consume "
                            f"'{_pending_bc_slot['text']}'"
                        )
                else:
                    _bc_prescan_state["absent_streak"] = 0

            elapsed = time.perf_counter() - t0
            if elapsed < ARMED_PERIOD:
                time.sleep(ARMED_PERIOD - elapsed)

    threading.Thread(target=_barcode_prescan_loop, daemon=True,
                     name="barcode-prescan").start()

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
    stream_miss_streak: int           = 0  
    STREAM_MISS_LIMIT: int            = 3  
    absence_frames:  int              = 0  
    presence_t0:     Optional[float]  = None  
    _fullscreen_window_set            = {"v": False}  

    scan_attempts: int = 0

    GATHER_RETRY_SLEEP            = 0.25  
    GATHER_ABORT_EMPTY_FRAMES     = 6    
    GATHER_LOG_EVERY              = 5     
    GATHER_MAX_ATTEMPTS           = 8

    def processing_thread(snap: np.ndarray) -> None:
        nonlocal shared_result

        flavor_text:  Optional[str] = None
        flavor_bbox                 = None
        expiry_outs:  List[Dict]    = []
        barcode_text: Optional[str] = None
        barcode_type: Optional[str] = None
        barcode_bbox                = None
        barcode_preview: Optional[np.ndarray] = None

        gather_attempt   = 0
        all_present      = False
        empty_yolo_runs  = 0   

        while not all_present:
            gather_attempt += 1

            ta = time.perf_counter()
            f_text, f_bbox = run_flavor_pipeline(snap, yolo, ocr_reader)
            log.info(
                f"[FLAVOR] try {gather_attempt} {int((time.perf_counter()-ta)*1000)} ms "
                f"→ '{f_text}'"
            )

            tb = time.perf_counter()
            e_outs = run_expiry_pipeline(snap, yolo, classifier, expiry_meta, device)
            log.info(
                f"[EXPIRY] try {gather_attempt} {int((time.perf_counter()-tb)*1000)} ms "
                f"→ {len(e_outs)} bbox(es)"
            )
            tc = time.perf_counter()
            bc_latest = barcode_grabber.get_latest()
            if bc_latest is not None:
                bc_frame, _ = bc_latest
                bc_text, bc_type, bc_bbox, bc_preview = run_barcode_pipeline(bc_frame, yolo)
            else:
                bc_text = bc_type = bc_bbox = bc_preview = None
            log.info(
                f"[BARCODE] try {gather_attempt} {int((time.perf_counter()-tc)*1000)} ms "
                f"(droidcam) → {(bc_type + ': ' + bc_text) if bc_text else ('bbox only' if bc_bbox else 'none')}"
            )

            if f_text:     flavor_text,  flavor_bbox  = f_text,  f_bbox
            if e_outs:     expiry_outs                = e_outs
            if bc_text:
                barcode_text, barcode_type = bc_text, bc_type
                with _last_decoded_lock:
                    _last_decoded["text"] = bc_text
                    _last_decoded["type"] = bc_type
                    _last_decoded["bbox"] = bc_bbox
                    _last_decoded["ts"]   = time.time()
            if bc_bbox:    barcode_bbox    = bc_bbox         
            if bc_preview is not None:
                barcode_preview = bc_preview                 

            with result_lock:
                shared_result.flavor_text     = flavor_text
                shared_result.flavor_bbox     = flavor_bbox
                shared_result.expiry_outputs  = expiry_outs
                shared_result.barcode_text    = barcode_text
                shared_result.barcode_type    = barcode_type
                shared_result.barcode_bbox    = barcode_bbox
                shared_result.barcode_preview = barcode_preview

            flavor_present  = bool(flavor_text)
            expiry_present  = bool(expiry_outs)
            inline_barcode_present  = bool(barcode_text)
            pending_slot_text, _    = _peek_pending_barcode()
            barcode_present         = inline_barcode_present or bool(pending_slot_text)
            all_present     = flavor_present and barcode_present
            niryo_has_anything = bool(f_text) or bool(e_outs)
            if not niryo_has_anything:
                empty_yolo_runs += 1
            else:
                empty_yolo_runs = 0

            if (gather_attempt == 1) or (gather_attempt % GATHER_LOG_EVERY == 0):
                log.info(
                    f"[gather] attempt {gather_attempt} "
                    f"flavor={'OK' if flavor_present else 'missing'} "
                    f"expiry={'OK' if expiry_present else 'missing'} "
                    f"barcode={'OK' if barcode_present else 'missing'}"
                )

            if all_present:
                log.info(
                    f"[gather] flavor + barcode acquired after {gather_attempt} attempt(s) "
                    f"— expiry={'OK' if expiry_present else 'missing → DEFECTIVE absent'}"
                )
                break

            if gather_attempt >= GATHER_MAX_ATTEMPTS:
                log.warning(
                    f"[gather] Hit max attempts ({GATHER_MAX_ATTEMPTS}) without "
                    f"flavor + barcode (flavor={'OK' if flavor_present else 'missing'}, "
                    f"barcode={'OK' if barcode_present else 'missing'}) — "
                    f"aborting inspection, no result emitted."
                )
                with result_lock:
                    shared_result.aborted = True
                    shared_result.done    = True
                return

            if empty_yolo_runs >= GATHER_ABORT_EMPTY_FRAMES:
                log.info(
                    f"[gather] Product removed mid-analysis "
                    f"({empty_yolo_runs} empty niryo frames) — aborting."
                )
                with result_lock:
                    shared_result.aborted = True
                    shared_result.done    = True
                return
            time.sleep(GATHER_RETRY_SLEEP)
            latest = grabber.get_latest()
            if latest is not None:
                snap, _ = latest
        best = next(
            (e for e in expiry_outs if e["status"] == "NORMAL"),
            expiry_outs[0] if expiry_outs else None,
        )
        detected_date = best["text"] if (best and best["status"] == "NORMAL") else None
        defect_type   = _classify_defect(expiry_outs, detected_date)
        final_class   = "NORMAL" if defect_type is None else "DEFECTIVE"
        overall_conf  = best["overall_conf"] if best else 0.0
        with result_lock:
            shared_result.final_label = "ok" if final_class == "NORMAL" else "defective"
            shared_result.defect_type = defect_type
        merged_barcode = barcode_text
        pending_text, _ = _peek_pending_barcode()
        if pending_text and not merged_barcode:
            merged_barcode = pending_text
        elif pending_text and merged_barcode and pending_text != merged_barcode:
            log.warning(
                f"[merge] pre-scan barcode {pending_text!r} != inline {merged_barcode!r} "
                f"— using pre-scan slot (operator-confirmed)"
            )
            merged_barcode = pending_text

        threading.Thread(
            target=robot.post_result_to_backend,
            args=(
                final_class,
                overall_conf,
                detected_date,
                flavor_text,
                time.perf_counter() - t_snap_start,
                merged_barcode,
                defect_type,
            ),
            daemon=True,
        ).start()

        _clear_pending_barcode(reason="consumed")

        if final_class == "DEFECTIVE":
            try:
                robot._action_queue.put_nowait({"id": str(uuid.uuid4()), "confidence": overall_conf})
                log.info(f"[gather] Defective queued for pick-and-place "
                         f"(queue size: {robot._action_queue.qsize()}).")
            except queue_module.Full:
                log.warning("[gather] Action queue full — defective item dropped.")
        robot._say("normal product" if final_class == "NORMAL" else "defective product")

        if final_class == "NORMAL":
             plc_send_command(PLC_BIT_CONFORM)
        else:
            plc_send_command(PLC_BIT_DEFECTIVE)

        with result_lock:
            shared_result.done = True
    try:
        while True:

            now = time.perf_counter()
            if now - last_robot_chk >= ROBOT_CHECK_INTERVAL_S:
                last_robot_chk = now
                if not robot._check_stream_reachable():
                    stream_miss_streak += 1
                    if stream_miss_streak == 1 or stream_miss_streak % 5 == 0:
                        log.warning(
                            f"[watchdog] niryo_stream /health probe failing "
                            f"(streak={stream_miss_streak}) — pipeline still running"
                        )
                        robot._emit_pipeline_state("DEGRADED",
                                             "niryo_stream /health flaky - still attempting")
                else:
                    if stream_miss_streak > 0:
                        log.info(
                            f"[watchdog] niryo_stream /health recovered "
                            f"after {stream_miss_streak} miss(es)"
                        )
                    stream_miss_streak = 0
                    if not robot._check_robot_connected_via_health() and not robot._robot_ok:
                        log.warning("[watchdog] Robot not yet connected -- continuing to stream.")
                        robot._emit_pipeline_state("RUNNING", "Stream up -- robot connecting ...")

            latest = grabber.get_latest()
            if latest is None: time.sleep(0.02); continue
            frame, fc = latest
            if fc == prev_fc: time.sleep(0.01); continue
            prev_fc   = fc
            now       = time.perf_counter()
            fps       = 1.0 / max(now - prev_tick, 1e-6)
            prev_tick = now

            if state == "SCANNING":
                chk      = yolo(frame, verbose=False, conf=YOLO_CONF_THRESHOLD)[0]
                detected = len(chk.boxes) > 0
                t_now    = time.perf_counter()
                if detected and not has_scanned:
                    presence_frames += 1
                    if presence_t0 is None:
                        presence_t0 = t_now
                elif not detected:
                    presence_frames = 0
                    presence_t0     = None
                    has_scanned     = False
                elapsed = (t_now - presence_t0) if presence_t0 else 0.0
                frac    = min(presence_frames / PRESENCE_FRAMES,
                              elapsed / PRESENCE_SETTLE_SECS,
                              1.0)
                if (presence_frames >= PRESENCE_FRAMES
                    and elapsed >= PRESENCE_SETTLE_SECS
                    and not has_scanned):
                    has_scanned   = True;  state = "PROCESSING"
                    t_snap_start  = presence_t0 if presence_t0 is not None else time.perf_counter()
                    snap          = frame.copy()
                    shared_result = InspectionResult(t_start=t_snap_start)
                    threading.Thread(target=processing_thread, args=(snap,), daemon=True).start()
                display = build_display(frame, shared_result, state, frac, fps, scan_attempts)

            elif state == "PROCESSING":
                with result_lock:
                    done    = shared_result.done
                    aborted = shared_result.aborted
                if aborted:
                    log.info("[state] Gather aborted — going straight to WAITING_REMOVAL.")
                    state          = "WAITING_REMOVAL"
                    absence_frames = 0
                elif done:
                    state = "RESULT";  show_timer = time.time()
                display = build_display(frame, shared_result, state, 1.0, fps, scan_attempts)

            elif state == "RESULT":
                display = build_display(frame, shared_result, state, 1.0, fps, scan_attempts)

                if time.time() - show_timer > RESULT_HOLD_SECS:

                    has_valid_date = any(
                        e["status"] == "NORMAL" for e in shared_result.expiry_outputs
                    )

                    if has_valid_date:
                        if scan_attempts > 0:
                            log.info(f"[state] Valid date found after {scan_attempts} attempt(s) "
                                     f"— resetting scan counter.")
                        scan_attempts = 0

                    else:
                        scan_attempts += 1
                        log.warning(
                            f"[state] No valid date on scan attempt "
                            f"{scan_attempts}/{MAX_SCAN_ATTEMPTS}."
                        )

                        if scan_attempts >= MAX_SCAN_ATTEMPTS:
                            log.warning(
                                f"[state] {MAX_SCAN_ATTEMPTS} consecutive scans with no valid date "
                                f"— forcing DEFECTIVE and queuing for pick-and-place."
                            )
                            forced_id   = str(uuid.uuid4())
                            forced_conf = 0.0
                            forced_defect = _classify_defect(
                                shared_result.expiry_outputs, None
                            ) or "blurry"
                            forced_bc = shared_result.barcode_text
                            pending_text_f, _ = _peek_pending_barcode()
                            if pending_text_f and not forced_bc:
                                forced_bc = pending_text_f
                            robot.post_result_to_backend(
                                "DEFECTIVE", forced_conf, None,
                                shared_result.flavor_text,
                                time.perf_counter() - t_snap_start,
                                forced_bc,
                                forced_defect,
                            )
                            _clear_pending_barcode(reason="consumed")
                            robot._say("defective product")
                            plc_send_command(PLC_BIT_DEFECTIVE)
                            try:
                                robot._action_queue.put_nowait({
                                    "id":         forced_id,
                                    "confidence": forced_conf,
                                })
                                log.info(
                                    f"[state] Forced DEFECTIVE item {forced_id} queued "
                                    f"(queue size: {robot._action_queue.qsize()})."
                                )
                            except queue_module.Full:
                                log.warning("[state] Action queue full — forced DEFECTIVE dropped.")
                            scan_attempts = 0
                    state          = "WAITING_REMOVAL"
                    absence_frames = 0
                    with result_lock:
                        shared_result.flavor_bbox    = None
                        shared_result.barcode_bbox   = None
                        shared_result.expiry_outputs = []
                    log.info(
                        f"[state] RESULT done — waiting for product removal "
                        f"({ABSENCE_FRAMES} clean frames)."
                    )
            elif state == "WAITING_REMOVAL":
                chk      = yolo(frame, verbose=False, conf=YOLO_CONF_THRESHOLD)[0]
                detected = len(chk.boxes) > 0
                if detected:
                    absence_frames = 0
                else:
                    absence_frames += 1
                    if absence_frames == 1:
                        with result_lock:
                            shared_result.flavor_text    = None
                            shared_result.barcode_text   = None
                            shared_result.barcode_type   = None
                            shared_result.final_label    = None
                            shared_result.defect_type    = None
                frac = min(absence_frames / ABSENCE_FRAMES, 1.0)
                display = build_display(frame, shared_result, state, frac, fps, scan_attempts)
                if absence_frames >= ABSENCE_FRAMES and robot._action_queue.unfinished_tasks == 0:
                    log.info("[state] Product removed and robot idle — re-arming for next inspection.")
                    state           = "SCANNING"
                    presence_frames = 0
                    presence_t0     = None
                    has_scanned     = False
                    absence_frames  = 0
                    shared_result   = InspectionResult()

            try:
                _publish_mjpeg(display)
            except Exception as exc:
                log.error(f"[stream] _publish_mjpeg failed: {exc}", exc_info=True)

            if SHOW_DEBUG_WINDOW:
                try:
                    cv2.imshow(DISPLAY_WINDOW_NAME, display)
                    if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                        break
                except Exception as exc:
                    log.warning(f"[stream] cv2.imshow failed (continuing): {exc}")

    except Exception as exc:
        log.error(f"[main] State-machine loop crashed: {exc}", exc_info=True)
    finally:
        grabber.stop()
        try:
            barcode_grabber.stop()
            _barcode_display_alive["v"] = False
        except Exception:
            pass
        if _plc_client is not None:
             try:
                 if _plc_client.get_connected():
                     _plc_client.disconnect()
                     log.info("[PLC] Disconnected")
             except Exception as exc:
                 log.debug(f"[PLC] Disconnect: {exc}")
        cv2.destroyAllWindows()
if __name__ == "__main__":
    main()
