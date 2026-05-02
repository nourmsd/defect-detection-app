const SystemTimeline = require('../models/SystemTimeline');
const ErrorLog = require('../models/ErrorLog');
const SystemSettings = require('../models/SystemSettings');
const { emitSocketEvent } = require('../utils/socketEvents');

/* =========================================================
   HELPERS
========================================================= */
const EVENT_COLOR_MAP = {
  start: 'yellow',
  running: 'green',
  stopping: 'red',
  fault: 'red',
  shutdown: 'red'
};

const todayStr = () => new Date().toISOString().slice(0, 10);

/* =========================================================
   TIMELINE
========================================================= */
async function addTimelineEvent(eventType, label, io) {
  const date = todayStr();
  const color = EVENT_COLOR_MAP[eventType] || 'yellow';
  const event = { eventType, color, label, timestamp: new Date() };

  await SystemTimeline.findOneAndUpdate(
    { date },
    { $push: { events: event } },
    { upsert: true, returnDocument: 'after' }
  );

  if (io) {
    emitSocketEvent(io, 'system_timeline', { date, event });
  }
  return event;
}

async function getTimeline(req, res) {
  try {
    const date = req.query.date || todayStr();
    const timeline = await SystemTimeline.findOne({ date });
    res.json({ date, events: timeline?.events || [] });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching timeline' });
  }
}

async function postTimelineEvent(req, res) {
  try {
    const { eventType, label } = req.body;
    if (!eventType) return res.status(400).json({ message: 'eventType required' });
    const event = await addTimelineEvent(eventType, label || eventType, req.io);
    res.json({ success: true, event });
  } catch (err) {
    res.status(500).json({ message: 'Error adding timeline event' });
  }
}

/* =========================================================
   ERROR LOGS
========================================================= */
async function createErrorLog(errorType, severity, message, suggestedAction, io) {
  const log = await ErrorLog.create({ errorType, severity, message, suggestedAction });

  if (io) {
    emitSocketEvent(io, 'error_log', {
      id: log._id.toString(),
      errorType,
      severity,
      message,
      suggestedAction: suggestedAction || '',
      timestamp: log.timestamp.toISOString(),
      resolved: false
    });
  }
  return log;
}

async function getErrorLogs(req, res) {
  try {
    const filter = {};
    if (req.query.resolved === 'false') filter.resolved = false;
    if (req.query.resolved === 'true') filter.resolved = true;
    if (req.query.severity) filter.severity = req.query.severity;

    const logs = await ErrorLog.find(filter).sort({ timestamp: -1 }).limit(100);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching error logs' });
  }
}

async function acknowledgeErrorLog(req, res) {
  try {
    const { id } = req.params;
    const log = await ErrorLog.findByIdAndUpdate(
      id,
      { resolved: true, acknowledgedBy: req.user.id, acknowledgedAt: new Date() },
      { returnDocument: 'after' }
    );
    if (!log) return res.status(404).json({ message: 'Log not found' });
    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ message: 'Error acknowledging log' });
  }
}

/* =========================================================
   SETTINGS  (key/value store)
========================================================= */
async function getSetting(key, defaultValue = null) {
  const s = await SystemSettings.findOne({ key });
  return s ? s.value : defaultValue;
}

async function setSetting(key, value) {
  await SystemSettings.findOneAndUpdate(
    { key },
    { key, value, updatedAt: new Date() },
    { upsert: true, returnDocument: 'after' }
  );
}

async function getSettings(req, res) {
  try {
    const all = await SystemSettings.find({});
    const result = { daily_target: 450, expiry_threshold: null };
    for (const s of all) result[s.key] = s.value;
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching settings' });
  }
}

async function updateSettings(req, res) {
  try {
    const { daily_target, expiry_threshold } = req.body;
    if (daily_target !== undefined) await setSetting('daily_target', Number(daily_target));
    if (expiry_threshold !== undefined) await setSetting('expiry_threshold', expiry_threshold);
    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ message: 'Error updating settings' });
  }
}

module.exports = {
  addTimelineEvent,
  getTimeline,
  postTimelineEvent,
  createErrorLog,
  getErrorLogs,
  acknowledgeErrorLog,
  getSetting,
  setSetting,
  getSettings,
  updateSettings
};
