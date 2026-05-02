const Inspection = require('../models/Inspection');
const crypto = require('crypto');
const { emitSocketEvent } = require('../utils/socketEvents');
const { notifyRobotService } = require('./robotController');
const { getSetting } = require('./systemController');

/* =========================================================
   NORMALIZATION
========================================================= */
function normalizeInspectionPayload(payload = {}) {
  const {
    label,
    confidence,
    device,
    processing_time,
    detected_date,
    timestamp,
  } = payload;

  if (!label || confidence === undefined) {
    const err = new Error('Missing required fields');
    err.statusCode = 400;
    throw err;
  }

  let normalizedLabel = 'OK';
  const labelLower = String(label).toLowerCase();

  if (['defective', 'fail', 'nok'].includes(labelLower)) {
    normalizedLabel = 'defective';
  }

  return {
    normalizedLabel,
    inspectionData: {
      label: normalizedLabel,
      confidence: Number(confidence) || 0,
      device: device || 'Niryo Camera',
      processing_time: Number(processing_time) || 0,
      detected_date: detected_date || 'missing',
      timestamp: timestamp ? new Date(timestamp) : null,
    },
  };
}

/* =========================================================
   MAIN PIPELINE (REAL-TIME FIRST, DB AFTER)
========================================================= */
async function persistInspectionAndBroadcast(payload = {}, io, meta = {}) {
  const { normalizedLabel, inspectionData } = normalizeInspectionPayload(payload);

  const serverTimestamp = inspectionData.timestamp instanceof Date && !Number.isNaN(inspectionData.timestamp.valueOf())
    ? inspectionData.timestamp
    : new Date();

  const eventPayload = {
    id: crypto.randomUUID(),
    label: normalizedLabel,
    confidence: inspectionData.confidence,
    processing_time: inspectionData.processing_time,
    detected_date: inspectionData.detected_date,
    timestamp: serverTimestamp.toISOString(),
  };

  emitSocketEvent(io, 'inspection', eventPayload);

  setImmediate(async () => {
    try {
      await Inspection.create({
        ...inspectionData,
        timestamp: serverTimestamp,
      });
    } catch (err) {
      console.error('[DB ERROR]', err);
    }
  });

  return {
    ...eventPayload,
    device: inspectionData.device,
    transport: meta.transport || 'socket',
  };
}

/* =========================================================
   ROBOT ALERT SYSTEM (NEW FIX)
========================================================= */
function sendRobotAlert(io, level, message) {
  emitSocketEvent(io, 'robot_alert', {
    level,
    message,
    timestamp: new Date().toISOString(),
  });
}

/* =========================================================
   LOG INSPECTION (HTTP ENTRYPOINT)
========================================================= */
async function logInspection(req, res) {
  try {
    const result = await persistInspectionAndBroadcast(
      req.body,
      req.io,
      { transport: 'http' }
    );

    // Notify robot arm about defective items (fire-and-forget)
    notifyRobotService(result).catch(() => {});

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Error logging inspection',
    });
  }
}

/* =========================================================
   HISTORY
========================================================= */
async function getHistory(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {};

    if (req.query.result === 'pass') filter.label = 'OK';
    if (req.query.result === 'fail') filter.label = 'defective';

    // Confidence may be stored as 0-1 decimal or 0-100 percent depending on AI pipeline.
    // Frontend always sends percent (0-100). Normalize at query time via $expr.
    if (req.query.minConfidence || req.query.maxConfidence) {
      const normalizedConf = {
        $cond: [{ $gt: ['$confidence', 1] }, '$confidence', { $multiply: ['$confidence', 100] }],
      };
      const exprs = [];
      if (req.query.minConfidence) exprs.push({ $gte: [normalizedConf, parseFloat(req.query.minConfidence)] });
      if (req.query.maxConfidence) exprs.push({ $lte: [normalizedConf, parseFloat(req.query.maxConfidence)] });
      filter.$expr = exprs.length === 1 ? exprs[0] : { $and: exprs };
    }

    if (req.query.dateFrom || req.query.dateTo) {
      filter.timestamp = {};
      if (req.query.dateFrom) filter.timestamp.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.timestamp.$lte = new Date(req.query.dateTo);
    }

    if (req.query.search) {
      filter.device = { $regex: req.query.search, $options: 'i' };
    }

    const [history, total] = await Promise.all([
      Inspection.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit),
      Inspection.countDocuments(filter),
    ]);

    res.json({
      data: history,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching history' });
  }
}

/* =========================================================
   STATS  — rolling 24 h window (reset at midnight each day)
   Efficiency = (totalInspected / dailyTarget) × 100  (Feature 3)
========================================================= */
async function getAdminStats(req, res) {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const filter = { timestamp: { $gte: startOfDay } };

    const [total, defective, dailyTarget] = await Promise.all([
      Inspection.countDocuments(filter),
      Inspection.countDocuments({ ...filter, label: 'defective' }),
      getSetting('daily_target', 450),
    ]);

    const target = Number(dailyTarget) || 450;
    const efficiency = total > 0 ? Math.min(100, (total / target) * 100) : 0;

    res.json({
      totalInspected: total,
      defective,
      efficiency: Number(efficiency.toFixed(1)),
      dailyTarget: target,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching stats' });
  }
}

/* =========================================================
   ANALYTICS
========================================================= */
async function getAnalytics(req, res) {
  try {
    const range = req.query.range || '30d';
    const now = new Date();

    let dateFrom = null;
    if (range === '7d') dateFrom = new Date(now - 7 * 86400000);
    else if (range === '30d') dateFrom = new Date(now - 30 * 86400000);
    else if (range === '90d') dateFrom = new Date(now - 90 * 86400000);
    // 'all' → dateFrom stays null → match = {} (full collection scan)

    const match = dateFrom ? { timestamp: { $gte: dateFrom } } : {};

    const [mainAgg, dailyTrend, confidenceDistribution, defectTypeBreakdown] = await Promise.all([
      Inspection.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            defective: { $sum: { $cond: [{ $eq: ['$label', 'defective'] }, 1, 0] } },
            avgConf: { $avg: '$confidence' },
          },
        },
      ]),

      Inspection.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            total: { $sum: 1 },
            defective: { $sum: { $cond: [{ $eq: ['$label', 'defective'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Confidence score distribution in 10 buckets (0-10, 10-20 … 90-100)
      Inspection.aggregate([
        { $match: match },
        {
          $addFields: {
            confPct: {
              $cond: [
                { $gt: ['$confidence', 1] },
                '$confidence',
                { $multiply: ['$confidence', 100] },
              ],
            },
          },
        },
        {
          $group: {
            _id: { $floor: { $divide: ['$confPct', 10] } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Defect breakdown by source device (only defective)
      Inspection.aggregate([
        { $match: { ...match, label: 'defective' } },
        {
          $group: {
            _id: { $ifNull: ['$device', 'Unknown'] },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const total = mainAgg[0]?.total || 0;
    const defective = mainAgg[0]?.defective || 0;
    const avgConf = mainAgg[0]?.avgConf || 0;

    res.json({
      kpis: {
        totalInspections: total,
        defective,
        passRate: total ? ((total - defective) / total) * 100 : 0,
        avgConfidence: avgConf > 1 ? avgConf : avgConf * 100,
      },
      dailyTrend,
      confidenceDistribution,
      defectTypeBreakdown,
    });
  } catch (err) {
    console.error('[Analytics] Error:', err.message, err.stack);
    res.status(500).json({ message: 'Error fetching analytics', detail: err.message });
  }
}

/* =========================================================
   WORKER DASHBOARD  — defaults to rolling 24 h (since midnight)
========================================================= */
async function getWorkerDashboardData(req, res) {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const filter = req.query.since
      ? { timestamp: { $gte: new Date(req.query.since) } }
      : { timestamp: { $gte: startOfDay } };

    const [recent, total, defective] = await Promise.all([
      Inspection.find(filter).sort({ timestamp: -1 }).limit(50),
      Inspection.countDocuments(filter),
      Inspection.countDocuments({ ...filter, label: 'defective' }),
    ]);

    res.json({
      gauges: {
        totalInspected: total,
        defective,
        conforming: total - defective,
      },
      history: recent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Worker dashboard error' });
  }
}

/* =========================================================
   CLEAN DATA
========================================================= */
async function cleanTestData(req, res) {
  try {
    const result = await Inspection.deleteMany({});
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error cleaning data' });
  }
}

/* =========================================================
   EXPORTS
========================================================= */
module.exports = {
  persistInspectionAndBroadcast,
  logInspection,
  getHistory,
  getAdminStats,
  getAnalytics,
  getWorkerDashboardData,
  cleanTestData,
  sendRobotAlert,
};
