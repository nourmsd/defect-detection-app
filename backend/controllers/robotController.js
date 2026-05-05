/**
 * robotController.js
 *
 * Handles:
 *   – Forwarding inspection results to niryo_pick_place.py
 *   – Free-motion toggle  (enable / disable learning mode on the arm)
 *   – Reading live joint positions from the arm
 *   – CRUD for named saved joint positions (persisted in MongoDB)
 */

const RobotPosition = require('../models/RobotPosition');
const { emitSocketEvent } = require('../utils/socketEvents');
const { createErrorLog } = require('./systemController');

const ROBOT_SERVICE_URL = process.env.ROBOT_SERVICE_URL || 'http://127.0.0.1:5002';
const NOTIFY_TIMEOUT_MS = 2000;
const ROBOT_DIAG_LOG_COOLDOWN_MS = 2 * 60 * 1000;
const recentRobotDiagLogs = new Map();

function dedupeRobotDiagLog(key) {
  const now = Date.now();
  const prev = recentRobotDiagLogs.get(key) || 0;
  if (now - prev < ROBOT_DIAG_LOG_COOLDOWN_MS) return true;
  recentRobotDiagLogs.set(key, now);
  return false;
}

async function logRobotDiagnostics(alerts = [], io) {
  if (!Array.isArray(alerts) || alerts.length === 0) return;
  for (const a of alerts) {
    const sevRaw = String(a?.level || 'warning').toLowerCase();
    const severity = sevRaw === 'critical' ? 'critical' : sevRaw === 'error' ? 'error' : 'warning';
    const code = String(a?.code || 'robot_diag');
    const message = String(a?.message || 'Robot diagnostic alert');
    const key = `${severity}:${code}:${message}`;
    if (dedupeRobotDiagLog(key)) continue;
    const suggestedAction = code === 'needs_calibration'
      ? 'Run robot calibration and retry operation.'
      : 'Inspect robot diagnostics and recover the affected subsystem.';
    await createErrorLog(`Robot Diagnostic (${code})`, severity, message, suggestedAction, io);
  }
}

async function logRobotCommandFailure(commandName, message, io) {
  const safeMsg = String(message || 'Unknown robot command failure');
  const key = `cmd:${commandName}:${safeMsg}`;
  if (dedupeRobotDiagLog(key)) return;
  await createErrorLog(
    `Robot Command Failed (${commandName})`,
    'error',
    safeMsg,
    'Check robot readiness/connection and retry command.',
    io
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   INTERNAL HELPER — fetch from the Python robot service
───────────────────────────────────────────────────────────────────────── */

async function robotFetch(path, options = {}, timeoutMs = NOTIFY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ROBOT_SERVICE_URL}${path}`, {
      ...options,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Robot service timed out');
    throw new Error(`Robot service unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   NOTIFY ROBOT SERVICE (pick-and-place trigger)
───────────────────────────────────────────────────────────────────────── */

async function notifyRobotService(inspectionResult) {
  const { id, label, confidence } = inspectionResult;
  if (String(label).toLowerCase() !== 'defective') return;

  try {
    const { ok, data } = await robotFetch('/inspection-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label, confidence }),
    });
    if (!ok) {
      console.warn(`[robot] pick-place service responded non-ok for item ${id}`);
      await logRobotCommandFailure('inspection-result', data?.reason || data?.message || 'Pick/place service rejected item');
    } else {
      console.log(`[robot] item ${id} queued=${data.queued}  queue_size=${data.queue_size ?? '-'}`);
    }
  } catch (err) {
    console.warn(`[robot] ${err.message}`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/robot/status
───────────────────────────────────────────────────────────────────────── */

async function getRobotStatus(req, res) {
  try {
    const { data } = await robotFetch('/status');
    await logRobotDiagnostics(data?.alerts, req.io);
    res.json(data);
  } catch {
    res.json({
      robot_connected:   false,
      robot_busy:        false,
      freemotion_active: false,
      last_action:       'offline',
      queue_size:        0,
    });
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/robot/action-result  (called by niryo_pick_place.py)
───────────────────────────────────────────────────────────────────────── */

function receiveActionResult(req, res) {
  const { item_id, action, error } = req.body || {};
  const timestamp = new Date().toISOString();

  if (req.io) {
    const level = error ? 'warning' : 'info';
    const message = error
      ? `Robot pick failed for item ${item_id}: ${error}`
      : `Robot pick complete for item ${item_id}`;
    emitSocketEvent(req.io, 'robot_alert', { level, message, timestamp });
  }

  console.log(`[robot] action-result: item=${item_id}  action=${action}${error ? `  error=${error}` : ''}`);
  res.json({ received: true });
}

/* ─────────────────────────────────────────────────────────────────────────
   FREE MOTION
───────────────────────────────────────────────────────────────────────── */

async function enableFreemotion(req, res) {
  try {
    const { ok, data } = await robotFetch('/freemotion/enable', { method: 'POST' });
    if (!ok) {
      return res.status(data.error === 'robot_busy' ? 409 : 503).json({
        success: false,
        message: data.error || 'Robot service error',
      });
    }
    res.json({ success: true, freemotion: true });
  } catch (err) {
    res.status(503).json({ success: false, message: err.message });
  }
}

async function disableFreemotion(req, res) {
  try {
    const { ok, data } = await robotFetch('/freemotion/disable', { method: 'POST' });
    if (!ok) {
      return res.status(503).json({ success: false, message: data.error || 'Robot service error' });
    }
    res.json({ success: true, freemotion: false });
  } catch (err) {
    res.status(503).json({ success: false, message: err.message });
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   GET CURRENT JOINTS (live read from arm)
───────────────────────────────────────────────────────────────────────── */

async function getCurrentJoints(req, res) {
  try {
    const { ok, data } = await robotFetch('/current-joints');
    if (!ok) {
      return res.status(503).json({ success: false, message: data.error || 'Robot service error' });
    }
    res.json({ success: true, joints: data.joints });
  } catch (err) {
    res.status(503).json({ success: false, message: err.message });
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   SAVED POSITIONS  (MongoDB CRUD)
───────────────────────────────────────────────────────────────────────── */

async function savePosition(req, res) {
  const { name } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'Position name is required' });
  }

  // Read live joints from the arm
  let joints;
  try {
    const { ok, data } = await robotFetch('/current-joints');
    if (!ok || !Array.isArray(data.joints)) {
      return res.status(503).json({ success: false, message: data.error || 'Cannot read joints from robot' });
    }
    joints = data.joints;
  } catch (err) {
    return res.status(503).json({ success: false, message: err.message });
  }

  try {
    const saved = await RobotPosition.create({ name: String(name).trim(), joints });
    console.log(`[robot] position saved: "${saved.name}" = [${joints.map(j => j.toFixed(3)).join(', ')}]`);
    res.status(201).json({ success: true, position: saved });
  } catch (err) {
    console.error('[robot] DB save error:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
}

async function getPositions(req, res) {
  try {
    const positions = await RobotPosition.find().sort({ createdAt: -1 });
    res.json({ success: true, positions });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Database error' });
  }
}

async function deletePosition(req, res) {
  try {
    const result = await RobotPosition.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ success: false, message: 'Position not found' });
    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Database error' });
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   ROBOT CONTROL COMMANDS  (forwarded to Python service)
───────────────────────────────────────────────────────────────────────── */

async function rebootTool(req, res) {
  try {
    const { ok, data } = await robotFetch('/reboot-tool', { method: 'POST' }, 10000);
    if (!ok) await logRobotCommandFailure('reboot-tool', data?.message || 'Tool reboot failed', req.io);
    res.json({ success: ok, message: data.message || (ok ? 'Tool reboot initiated' : 'Reboot failed') });
  } catch (err) {
    await logRobotCommandFailure('reboot-tool', err.message, req.io);
    res.status(503).json({ success: false, message: err.message });
  }
}

async function rebootMotors(req, res) {
  try {
    const { ok, data } = await robotFetch('/reboot-motors', { method: 'POST' }, 10000);
    if (!ok) await logRobotCommandFailure('reboot-motors', data?.message || 'Motors reboot failed', req.io);
    res.json({ success: ok, message: data.message || (ok ? 'Motors reboot initiated' : 'Reboot failed') });
  } catch (err) {
    await logRobotCommandFailure('reboot-motors', err.message, req.io);
    res.status(503).json({ success: false, message: err.message });
  }
}

async function calibrate(req, res) {
  try {
    const { ok, data } = await robotFetch('/calibrate', { method: 'POST' }, 30000);
    if (!ok) await logRobotCommandFailure('calibrate', data?.message || 'Calibration failed', req.io);
    res.json({ success: ok, message: data.message || (ok ? 'Calibration started' : 'Calibration failed') });
  } catch (err) {
    await logRobotCommandFailure('calibrate', err.message, req.io);
    res.status(503).json({ success: false, message: err.message });
  }
}

async function emergencyStop(req, res) {
  try {
    const { ok, data } = await robotFetch('/emergency-stop', { method: 'POST' }, 3000);
    if (!ok) await logRobotCommandFailure('emergency-stop', data?.message || 'Emergency stop failed', req.io);
    res.json({ success: ok, message: data.message || (ok ? 'Emergency stop activated' : 'E-stop command failed') });
  } catch (err) {
    await logRobotCommandFailure('emergency-stop', err.message, req.io);
    res.status(503).json({ success: false, message: err.message });
  }
}

module.exports = {
  notifyRobotService,
  getRobotStatus,
  receiveActionResult,
  enableFreemotion,
  disableFreemotion,
  getCurrentJoints,
  savePosition,
  getPositions,
  deletePosition,
  rebootTool,
  rebootMotors,
  calibrate,
  emergencyStop,
};
