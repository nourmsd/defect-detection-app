const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const inspectionController = require('./controllers/inspectionController');
const { notifyRobotService } = require('./controllers/robotController');
const { closeStaleOpenSessions } = require('./controllers/attendanceController');
const authController = require('./controllers/authController');
const authRoutes = require('./routes/auth');
const inspectionRoutes = require('./routes/inspection');
const robotRoutes = require('./routes/robot');
const attendanceRoutes = require('./routes/attendance');
const systemRoutes = require('./routes/system');
const authMiddleware = require('./middleware/auth');
const roleMiddleware = require('./middleware/role');
const { emitSocketEvent } = require('./utils/socketEvents');
const { sendDangerAlert, sendSystemErrorAlert } = require('./services/emailService');
const { createErrorLog, addTimelineEvent } = require('./controllers/systemController');
const User = require('./models/User');

const PIPELINE_EVENT_PREFIX = 'SOCKET_EVENT ';
const NIRYO_STREAM_URL = process.env.NIRYO_STREAM_URL || 'http://127.0.0.1:5001';
const ROBOT_SERVICE_URL = process.env.ROBOT_SERVICE_URL || 'http://127.0.0.1:5002';
const PIPELINE_EVENT_POLL_MS = Number(process.env.PIPELINE_EVENT_POLL_MS || 3000);
const AI_STREAM_URL = `http://127.0.0.1:${process.env.AI_STREAM_PORT || '5003'}`;

let aiProc = null;
let streamProc = null;
let pickPlaceProc = null;
let systemEventTimer = null;

let lastRobotAlertIds = new Set();
let lastSystemHealthSignature = '';

let globalSocketServer = null;
let connectedClients = 0;

// Robot-gated pipeline state machine
// States: IDLE (no robot) â†’ READY/RUNNING (robot connected) â†’ PAUSED (robot lost)
let _robotConnected = false;   // last known robot connection state
let _pipelineActive = false;   // true when AI pipeline process is alive

// Guard to prevent alert email floods (max 1 per 5 min per message)
const recentDangerAlerts = new Map();
const DANGER_COOLDOWN_MS = 5 * 60 * 1000;

/* ===================== PYTHON ===================== */

function buildBundledPythonEnv(extraEnv = {}) {
  return { ...process.env, ...extraEnv };
}

function resolvePythonCommand() {
  console.log("[Python] Using system python");
  return { command: 'python', args: [] };
}

/* ===================== HELPERS ===================== */

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { response: res, data };
  } finally {
    clearTimeout(t);
  }
}

const safeFetch = async (url) => {
  try {
    const res = await fetchJsonWithTimeout(url, {}, 2500);
    return res?.data || null;
  } catch {
    return null;
  }
};

function normalizeRobotAlertLevel(level) {
  const l = String(level || '').toLowerCase();
  return ['critical', 'error', 'warning'].includes(l) ? l : 'warning';
}

/* ===================== DANGER ALERT ===================== */

async function triggerDangerAlert(io, message) {
  const now = Date.now();
  const lastSent = recentDangerAlerts.get(message) || 0;
  if (now - lastSent < DANGER_COOLDOWN_MS) return; // throttle

  recentDangerAlerts.set(message, now);

  // Emit socket event to all connected clients
  emitSocketEvent(io, 'danger_alert', {
    message,
    timestamp: new Date().toISOString(),
    level: 'critical'
  });

  // System-error emails go ONLY to currently-online workers (not supervisors/admins)
  try {
    const onlineWorkers = await User.find({ role: 'worker', isOnline: true }).select('email');
    const emails = onlineWorkers.map(u => u.email).filter(Boolean);
    if (emails.length > 0) {
      await sendSystemErrorAlert(emails);
    }
  } catch (err) {
    console.error('[DangerAlert] Email error:', err.message);
  }
}

// Supervisor emergency broadcast â€” sends to ALL approved users' emails
async function triggerSupervisorBroadcast(io, message) {
  const now = Date.now();
  const lastSent = recentDangerAlerts.get(message) || 0;
  if (now - lastSent < DANGER_COOLDOWN_MS) return;

  recentDangerAlerts.set(message, now);

  emitSocketEvent(io, 'danger_alert', {
    message,
    timestamp: new Date().toISOString(),
    level: 'critical'
  });

  try {
    const users = await User.find({ status: 'approved' }).select('email');
    const emails = users.map(u => u.email).filter(Boolean);
    await sendDangerAlert(emails);
  } catch (err) {
    console.error('[SupervisorBroadcast] Email error:', err.message);
  }
}

/* ===================== PIPELINE EVENTS ===================== */

async function handlePipelineStructuredEvent(msg, io) {
  if (!msg || typeof msg !== 'object') return;
  const { type, payload } = msg;

  if (type === 'inspection') {
    const result = await inspectionController.persistInspectionAndBroadcast(payload, io, {
      transport: 'pipeline-stdout',
    });
    notifyRobotService(result).catch(() => {});
  }

  if (type === 'robot_alert' || type === 'system_health') {
    emitSocketEvent(io, type, payload);
  }

  if (type === 'robot_alert') {
    const level = payload?.level || 'warning';
    const message = payload?.message || 'Robot alert';

    // Auto-create error log for robot alerts
    const SUGGESTED = {
      'conveyor': 'Check conveyor belt connection and restart if needed.',
      'robot': 'Inspect robot arm, check joints and cable connections.',
      'confidence': 'Retrain AI model or clean camera lens.',
      'plc': 'Check PLC connection and emergency stop state.',
    };
    const key = Object.keys(SUGGESTED).find(k => message.toLowerCase().includes(k)) || '';
    const suggested = SUGGESTED[key] || 'Inspect the affected subsystem and restart if needed.';

    createErrorLog(
      level === 'critical' ? 'Robot Critical Fault' : 'Robot Alert',
      level === 'critical' ? 'critical' : level === 'error' ? 'error' : 'warning',
      message,
      suggested,
      io
    ).catch(e => console.error('[ErrorLog] Create failed:', e.message));

    // Trigger danger alert email for critical alerts
    if (level === 'critical' || level === 'error') {
      triggerDangerAlert(io, message).catch(() => {});
    }
  }

  if (type === 'inference_status') {
    emitSocketEvent(io, 'inference_status', payload);
  }
}

/* ===================== STREAM ===================== */

async function startNiryoStreamService() {
  // OBSOLETE: niryo_stream.py used to be a separate process holding its own
  // pyniryo connection just to serve the camera MJPEG. After the merge into
  // app.py (which now serves /stream on :5001 itself using the same single
  // NiryoRobot connection it already holds for motion control), spawning
  // niryo_stream.py creates a SECOND TCP connection to robot port 40001.
  // The arm only allows one connection â€” the two processes kick each other
  // out in a loop, which is what your "utf-8 codec can't decode byte 0xab"
  // error and the "Disconnected from robot / Connecting to robot" ping-pong
  // were showing. This function is now a no-op.
  return;
}

async function startNiryoPickPlaceService() {
  if (pickPlaceProc && !pickPlaceProc.killed) return;

  // If already started externally (e.g. start_all.bat), don't spawn duplicate.
  try {
    const { response, data } = await fetchJsonWithTimeout(`${ROBOT_SERVICE_URL}/status`, {}, 2500);
    const looksLikeRobotService =
      Boolean(response?.ok) &&
      data &&
      typeof data === 'object' &&
      (
        // niryo_pick_place.py returns these keys
        Object.prototype.hasOwnProperty.call(data, 'robot_connected') ||
        Object.prototype.hasOwnProperty.call(data, 'last_action') ||
        Object.prototype.hasOwnProperty.call(data, 'queue_size')
      );
    if (looksLikeRobotService) {
      console.log('[niryo-pick-place] service already running â€” reusing existing process');
      return;
    }
  } catch {
    // ignore probe errors â€” we'll attempt to spawn below
  }

  const script = path.join(__dirname, 'app.py');
  let cmd;
  try {
    cmd = resolvePythonCommand();
  } catch (e) {
    console.warn('[niryo-pick-place] Python venv not found â€” pick/place service disabled:', e.message);
    return;
  }

  try {
    pickPlaceProc = spawn(cmd.command, [...cmd.args, '-u', script], {
      cwd: __dirname,
      env: buildBundledPythonEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const _healthPattern = /GET \/(status|health)/;
    pickPlaceProc.stdout.on('data', (d) => {
      d.toString().split('\n').forEach((raw) => {
        const l = raw.trim();
        if (!l) return;
        // SOCKET_EVENT lines are structured pipeline events emitted by app.py
        // (inspections, pipeline-state updates). Parse + persist + broadcast.
        if (l.startsWith(PIPELINE_EVENT_PREFIX)) {
          try {
            const json = JSON.parse(l.replace(PIPELINE_EVENT_PREFIX, ''));
            handlePipelineStructuredEvent(json, globalSocketServer);
          } catch (e) {
            console.warn('[niryo-pick-place] bad json:', l.slice(0, 120));
          }
          return;
        }
        if (!_healthPattern.test(l)) console.log(`[niryo-pick-place] ${l}`);
      });
    });
    pickPlaceProc.stderr.on('data', (d) => {
      d.toString().split('\n').forEach((line) => {
        const l = line.trim();
        if (l && !_healthPattern.test(l)) console.log(`[niryo-pick-place] ${l}`);
      });
    });
    pickPlaceProc.on('exit', (code) => {
      console.warn(`[niryo-pick-place] exited with code ${code} â€” will restart in 5s`);
      pickPlaceProc = null;
      setTimeout(() => { startNiryoPickPlaceService(); }, 5000);
    });
  } catch (e) {
    console.warn('[niryo-pick-place] spawn failed:', e.message);
  }
}

/* ===================== AI PIPELINE ===================== */

function startAIPipeline(io) {
  // OBSOLETE: the AI pipeline is now part of app.py (spawned by
  // startNiryoPickPlaceService). The standalone niryo_live_expiry_app.py no
  // longer exists. We keep this function as a no-op so existing call sites
  // don't break, and so SOCKET_EVENTs from app.py still reach the dashboard
  // (we cache the io reference here for handlePipelineStructuredEvent).
  globalSocketServer = io;
  return;

  // eslint-disable-next-line no-unreachable
  if (aiProc && !aiProc.killed) return;

  // Hard prerequisite: robot must be connected before starting inference
  if (!_robotConnected) {
    console.log('[ai-pipeline] Robot not connected â€” pipeline start deferred until robot is reachable');
    return;
  }

  const aiRoot = path.join(__dirname, '..', '..', 'ai');
  const script = path.join(aiRoot, 'niryo_live_expiry_app.py');
  let cmd;
  try {
    cmd = resolvePythonCommand();
  } catch (e) {
    console.warn('[ai-pipeline] Python venv not found â€” AI pipeline disabled:', e.message);
    return;
  }

  _pipelineActive = true;
  console.log('[ai-pipeline] Robot connected â€” starting frame acquisition and inference loop');

  aiProc = spawn(cmd.command, [...cmd.args, '-u', script], {
    cwd: aiRoot,
    env: buildBundledPythonEnv({
      PIPELINE_EVENT_PREFIX,
      NIRYO_STREAM_URL: `${NIRYO_STREAM_URL}/stream`,
      AI_STREAM_PORT: process.env.AI_STREAM_PORT || '5003',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  aiProc.stdout.on('data', (data) => {
    data.toString().split('\n').forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith(PIPELINE_EVENT_PREFIX)) {
        try {
          const json = JSON.parse(line.replace(PIPELINE_EVENT_PREFIX, ''));
          handlePipelineStructuredEvent(json, io);
        } catch (e) {
          console.warn('[ai-pipeline] bad json:', line.slice(0, 120));
        }
      } else {
        // Only log frame analysis lines when robot is confirmed connected
        if (_robotConnected) {
          console.log(`[ai-pipeline] ${line}`);
        }
      }
    });
  });

  aiProc.stderr.on('data', (data) => {
    data.toString().split('\n').forEach((line) => {
      if (line.trim()) console.warn(`[ai-pipeline][stderr] ${line.trim()}`);
    });
  });

  aiProc.on('exit', (code) => {
    console.warn(`[ai-pipeline] exited with code ${code}`);
    aiProc = null;
    _pipelineActive = false;
    // Re-check robot health before deciding whether to restart
    setTimeout(async () => {
      const health = await safeFetch(`${NIRYO_STREAM_URL}/health`);
      const robotOk = Boolean(health?.robot_connected);
      _robotConnected = robotOk;
      if (robotOk) {
        console.log('[ai-pipeline] Robot still connected â€” restarting in 3s');
        setTimeout(() => startAIPipeline(io), 3000);
      } else {
        console.log('[ai-pipeline] Robot disconnected â€” pipeline suspended until robot reconnects');
        emitSocketEvent(io, 'inference_status', {
          status: 'PAUSED',
          detected_date: 'missing',
          confidence: 0,
          yolo_detections: 0,
          inference_ms: 0,
          fps: 0,
          pipeline_state: 'PAUSED',
          message: 'Robot disconnected - AI pipeline paused',
          timestamp: new Date().toISOString(),
        });
      }
    }, 2000);
  });
}

/* ===================== STOP AI PIPELINE ===================== */

function stopAIPipeline(io) {
  if (!_pipelineActive && (!aiProc || aiProc.killed)) return;
  _pipelineActive = false;
  console.log('[ai-pipeline] Robot disconnected â€” stopping inference loop gracefully');

  if (aiProc && !aiProc.killed) {
    aiProc.kill('SIGTERM');
    // Force-kill after 5 s if the process hangs
    const forceKill = setTimeout(() => {
      if (aiProc && !aiProc.killed) {
        console.warn('[ai-pipeline] Force-killing after 5 s timeout');
        aiProc.kill('SIGKILL');
      }
    }, 5000);
    forceKill.unref(); // don't prevent process exit
  }
  aiProc = null;

  if (io) {
    emitSocketEvent(io, 'inference_status', {
      status: 'PAUSED',
      detected_date: 'missing',
      confidence: 0,
      yolo_detections: 0,
      inference_ms: 0,
      fps: 0,
      pipeline_state: 'PAUSED',
      message: 'Robot disconnected - AI pipeline paused',
      timestamp: new Date().toISOString(),
    });
  }
}

/* ===================== SYSTEM POLLING ===================== */

// State-driven timeline tracking
let _prevTimelineState = null;  // 'idle' | 'starting' | 'running' | 'stopped'
let _prevPlcOnline = null;      // null = first probe (don't emit); true/false = known state

function deriveTimelineState(robotConnected, aiOnline, dbOnline) {
  if (!robotConnected) return 'stopped';
  if (robotConnected && aiOnline && dbOnline) return 'running';
  if (robotConnected) return 'starting';
  return 'idle';
}

async function pollSystemEvents(io) {
  try {
    const health = await safeFetch(`${NIRYO_STREAM_URL}/health`);
    const robotHealth = await safeFetch(`${NIRYO_STREAM_URL}/robot-health`);
    const aiHealth = await safeFetch(`${AI_STREAM_URL}/health`);

    const robotConnected = Boolean(health?.robot_connected);
    const aiOnline = Boolean(aiHealth?.status === 'ok' || aiHealth?.status === 'online');
    const dbOnline = mongoose.connection.readyState === 1;
    // PLC is considered online when robot arm connection is established
    const plcOnline = robotConnected;

    // â”€â”€ Robot-gated AI pipeline lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (robotConnected && !_robotConnected) {
      // Robot just came online â€” arm the pipeline
      _robotConnected = true;
      console.log('[system] Robot connected â€” starting AI pipeline (frame acquisition + inference)');
      emitSocketEvent(io, 'inference_status', {
        status: 'READY',
        detected_date: 'missing',
        confidence: 0,
        yolo_detections: 0,
        inference_ms: 0,
        fps: 0,
        pipeline_state: 'READY',
        message: 'Robot connected - AI pipeline active',
        timestamp: new Date().toISOString(),
      });
      startAIPipeline(io);
    } else if (!robotConnected && _robotConnected) {
      // Robot just went offline â€” suspend everything
      _robotConnected = false;
      console.log('[system] Robot disconnected â€” suspending AI pipeline (no inference, no frame analysis)');
      stopAIPipeline(io);
    }

    // State-driven timeline events
    const newState = deriveTimelineState(robotConnected, aiOnline, dbOnline);
    if (newState !== _prevTimelineState) {
      const now = new Date();
      const hour = now.getHours();
      // Only log events during production window (07:00 â€“ 19:00)
      if (hour >= 7 && hour < 19) {
        if (newState === 'starting' && _prevTimelineState !== 'running') {
          addTimelineEvent('start', 'Robot + PLC Connected â€” System Starting', io).catch(() => {});
        } else if (newState === 'running') {
          addTimelineEvent('running', 'All Systems Online â€” Fully Operational', io).catch(() => {});
        } else if (newState === 'stopped') {
          addTimelineEvent('stopping', 'Robot Disconnected â€” System Stopped', io).catch(() => {});
        }
      }
      _prevTimelineState = newState;
    }

    // PLC connectivity transitions â€” emitted independently of the combined
    // robot/AI/db timeline so PLC online/offline edges are individually visible.
    if (_prevPlcOnline !== null && plcOnline !== _prevPlcOnline) {
      const hour = new Date().getHours();
      if (hour >= 7 && hour < 19) {
        if (plcOnline) {
          addTimelineEvent('start', 'PLC Connected', io).catch(() => {});
        } else {
          addTimelineEvent('stopping', 'PLC Disconnected', io).catch(() => {});
        }
      }
    }
    _prevPlcOnline = plcOnline;

    const payload = {
      fps: Number(health?.avg_fps) || 0,
      camera: health?.camera_status || 'Unknown',
      stream: health?.status || 'offline',
      robot_connected: robotConnected,
      robot_status: robotConnected ? 'online' : 'offline',
      ai_status: aiOnline ? 'online' : 'offline',
      plc_status: plcOnline ? 'online' : 'offline',
      db_status: dbOnline ? 'online' : 'offline',
    };

    const sig = JSON.stringify(payload);
    if (sig !== lastSystemHealthSignature) {
      lastSystemHealthSignature = sig;
      emitSocketEvent(io, 'system_health', payload);
    }

    const alerts = robotHealth?.alerts || [];
    const active = new Set();

    for (const a of alerts) {
      const id = a.id || `${a.severity}:${a.message}`;
      active.add(id);

      if (!lastRobotAlertIds.has(id)) {
        const level = normalizeRobotAlertLevel(a.severity);
        emitSocketEvent(io, 'robot_alert', {
          level,
          message: a.message || 'Robot alert',
          timestamp: new Date().toISOString(),
        });

        if (level === 'critical' || level === 'error') {
          createErrorLog(
            'Robot Fault',
            level,
            a.message || 'Robot alert',
            'Inspect the robot arm and check error codes.',
            io
          ).catch(() => {});

          // System error alert to online workers only
          triggerDangerAlert(io, a.message || 'Critical robot fault detected').catch(() => {});
        }
      }
    }

    lastRobotAlertIds = active;
  } catch (err) {
    const dbOnline = mongoose.connection.readyState === 1;
    const offline = {
      fps: 0, camera: 'offline', stream: 'offline',
      robot_connected: false, robot_status: 'offline',
      ai_status: 'offline', plc_status: 'offline',
      db_status: dbOnline ? 'online' : 'offline'
    };
    const sig = JSON.stringify(offline);
    if (sig !== lastSystemHealthSignature) {
      lastSystemHealthSignature = sig;
      emitSocketEvent(io, 'system_health', offline);
    }
    // Health endpoint unreachable â€” treat as robot offline
    if (_robotConnected) {
      _robotConnected = false;
      stopAIPipeline(io);
    }
    console.warn('[system-events] poll failed:', err.message);
  }
}

/* ===================== 7PM DAILY RESET ===================== */

function scheduleDaily7PMReset(io) {
  function msUntilNext7PM() {
    const now = new Date();
    const next7PM = new Date(now);
    next7PM.setHours(19, 0, 0, 0);
    if (now >= next7PM) next7PM.setDate(next7PM.getDate() + 1);
    return next7PM.getTime() - now.getTime();
  }

  function fireDailyReset() {
    console.log('[DailyReset] 19:00 â€” Resetting daily AI pipeline counters');
    emitSocketEvent(io, 'daily_reset', { timestamp: new Date().toISOString() });
    // Schedule next reset for tomorrow
    setTimeout(fireDailyReset, msUntilNext7PM());
  }

  setTimeout(fireDailyReset, msUntilNext7PM());
  console.log(`[DailyReset] Scheduled for 19:00 (in ${Math.round(msUntilNext7PM() / 60000)} min)`);
}

function startSystemEventPolling(io) {
  if (systemEventTimer) return;
  pollSystemEvents(io);
  systemEventTimer = setInterval(() => pollSystemEvents(io), PIPELINE_EVENT_POLL_MS);
}

/* ===================== EXPRESS ===================== */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Inject io into authController so it can emit attendance events
authController.setSocketServer(io);

io.on('connection', (socket) => {
  connectedClients++;
  socket.on('disconnect', () => connectedClients--);
});

app.use(cors());
app.use(express.json());

// Attach io to every request so controllers can emit events
app.use((req, _res, next) => { req.io = io; next(); });

app.use('/api', authRoutes);
app.use('/api', inspectionRoutes);
app.use('/api/robot', robotRoutes);
app.use('/api', attendanceRoutes);
app.use('/api', systemRoutes);

app.get('/api/system-events', (req, res) => {
  res.json({ status: 'alive', connectedClients, time: new Date().toISOString() });
});

app.get('/api/stream/health', async (req, res) => {
  const data = await safeFetch(`${NIRYO_STREAM_URL}/health`);
  res.json(data || { status: 'offline' });
});

/* ===================== DANGER ALERT ENDPOINT ===================== */

// Admin can manually trigger a danger alert
app.post('/api/admin/danger-alert',
  authMiddleware,
  roleMiddleware(['supervisor']),
  async (req, res) => {
    const message = req.body?.message || 'Manual danger alert triggered by supervisor';
    await triggerSupervisorBroadcast(io, message);
    res.json({ success: true, message: 'Danger alert sent to all users' });
  }
);

/* ===================== START ===================== */

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('Connected to MongoDB');

    // â”€â”€ Startup cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // 1. Reset isOnline for all users â€” server restart means no active sessions.
    await User.updateMany({ isOnline: true }, { $set: { isOnline: false } })
      .then(r => { if (r.modifiedCount) console.log(`[startup] Reset isOnline for ${r.modifiedCount} user(s)`); })
      .catch(e => console.error('[startup] isOnline reset failed:', e.message));

    // 2. Seal attendance sessions left open by a crash / browser close on a previous day.
    await closeStaleOpenSessions().catch(e =>
      console.error('[startup] Stale session cleanup failed:', e.message)
    );
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Start robot control first so it can calibrate/move before the camera stream
    // grabs a connection (some robot firmware/SDK combos behave poorly with
    // multiple concurrent TCP clients).
    startNiryoPickPlaceService();
    // Give pick/place time to calibrate/move before stream connects.
    setTimeout(() => startNiryoStreamService(), 12000);
    // AI pipeline is NOT started here â€” startSystemEventPolling checks robot health
    // and calls startAIPipeline only when _robotConnected becomes true.
    startSystemEventPolling(io);
    scheduleDaily7PMReset(io);

    // Log system start on boot
    addTimelineEvent('start', 'Server Started', io).catch(() => {});

    server.listen(PORT, () =>
      console.log(`Server running on port ${PORT}`)
    );
  })
  .catch(console.error);

