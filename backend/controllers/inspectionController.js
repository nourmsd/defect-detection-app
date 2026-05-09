const Inspection = require('../models/Inspection');
const ErrorLog = require('../models/ErrorLog');
const crypto = require('crypto');
const { emitSocketEvent } = require('../utils/socketEvents');
const { notifyRobotService } = require('./robotController');
const { getSetting } = require('./systemController');

/* =========================================================
   NORMALIZATION
========================================================= */
const ALLOWED_DEFECT_TYPES = ['absent', 'blurry', 'expired'];

function normalizeInspectionPayload(payload = {}) {
  const {
    id,
    label,
    confidence,
    processing_time,
    expiry_date,
    detected_date,        // legacy alias from older clients
    flavor,
    defect_type,
    timestamp,
  } = payload;

  if (!label || confidence === undefined) {
    const err = new Error('Missing required fields');
    err.statusCode = 400;
    throw err;
  }

  const labelLower = String(label).toLowerCase();
  const normalizedLabel =
    ['defective', 'fail', 'nok'].includes(labelLower) ? 'defective' : 'ok';

  let normalizedDefectType = null;
  if (defect_type) {
    const dt = String(defect_type).toLowerCase();
    if (ALLOWED_DEFECT_TYPES.includes(dt)) normalizedDefectType = dt;
  }
  // OK products never carry a defect type.
  if (normalizedLabel === 'ok') normalizedDefectType = null;

  return {
    normalizedLabel,
    inspectionData: {
      inspection_id: id ? String(id) : null,
      label: normalizedLabel,
      defect_type: normalizedDefectType,
      flavor: flavor || 'missing',
      expiry_date: expiry_date || detected_date || 'missing',
      confidence: Number(confidence) || 0,
      processing_time: Number(processing_time) || 0,
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
    id: inspectionData.inspection_id || crypto.randomUUID(),
    label: normalizedLabel,
    defect_type: inspectionData.defect_type,
    flavor: inspectionData.flavor,
    expiry_date: inspectionData.expiry_date,
    confidence: inspectionData.confidence,
    processing_time: inspectionData.processing_time,
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

    if (req.query.result === 'pass') filter.label = 'ok';
    if (req.query.result === 'fail') filter.label = 'defective';

    if (req.query.defectType && ALLOWED_DEFECT_TYPES.includes(req.query.defectType)) {
      filter.defect_type = req.query.defectType;
    }

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
      const re = { $regex: req.query.search, $options: 'i' };
      filter.$or = [{ flavor: re }, { expiry_date: re }, { inspection_id: re }];
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

    const robotErrorMatch = {
      ...(dateFrom ? { timestamp: { $gte: dateFrom } } : {}),
      errorType: { $regex: /robot/i },
      resolved: true,
      acknowledgedAt: { $ne: null },
    };

    const [mainAgg, dailyTrend, confidenceDistribution, defectTypeBreakdown, robotMTBF] = await Promise.all([
      Inspection.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            defective: { $sum: { $cond: [{ $eq: ['$label', 'defective'] }, 1, 0] } },
            avgConf: { $avg: '$confidence' },
            avgProcessingTime: { $avg: '$processing_time' },
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

      // Defect breakdown by defect_type (absent / blurry / expired)
      Inspection.aggregate([
        { $match: { ...match, label: 'defective' } },
        {
          $group: {
            _id: { $ifNull: ['$defect_type', 'unknown'] },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ]),

      // Robot MTBF: avg duration (hours) from error log timestamp → fix (acknowledgedAt)
      ErrorLog.aggregate([
        { $match: robotErrorMatch },
        {
          $group: {
            _id: null,
            avgMs: { $avg: { $subtract: ['$acknowledgedAt', '$timestamp'] } },
          },
        },
      ]),
    ]);

    const total = mainAgg[0]?.total || 0;
    const defective = mainAgg[0]?.defective || 0;
    const avgConf = mainAgg[0]?.avgConf || 0;
    const avgProcessingTime = mainAgg[0]?.avgProcessingTime || 0;
    const mtbfHours = robotMTBF[0]?.avgMs ? robotMTBF[0].avgMs / 3600000 : 0;

    res.json({
      kpis: {
        totalInspections: total,
        defective,
        passRate: total ? ((total - defective) / total) * 100 : 0,
        avgConfidence: avgConf > 1 ? avgConf : avgConf * 100,
        avgProcessingTime,
        MTBF: mtbfHours,
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
