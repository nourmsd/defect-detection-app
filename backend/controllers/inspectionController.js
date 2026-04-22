const Inspection = require('../models/Inspection');

exports.getHistory = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    // Build filter
    const filter = {};
    if (req.query.result === 'pass') filter.label = 'OK';
    else if (req.query.result === 'fail') filter.label = 'defective';

    if (req.query.minConfidence) {
      filter.confidence = { ...filter.confidence, $gte: parseFloat(req.query.minConfidence) };
    }
    if (req.query.maxConfidence) {
      filter.confidence = { ...filter.confidence, $lte: parseFloat(req.query.maxConfidence) };
    }

    if (req.query.dateFrom) {
      filter.timestamp = { ...filter.timestamp, $gte: new Date(req.query.dateFrom) };
    }
    if (req.query.dateTo) {
      filter.timestamp = { ...filter.timestamp, $lte: new Date(req.query.dateTo) };
    }

    if (req.query.search) {
      filter.device = { $regex: req.query.search, $options: 'i' };
    }

    const [history, total] = await Promise.all([
      Inspection.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit),
      Inspection.countDocuments(filter)
    ]);

    const mapped = history.map(h => ({
      id: h._id,
      label: h.label,
      confidence: h.confidence,
      timestamp: h.timestamp,
      device: h.device,
      processing_time: h.processing_time
    }));

    res.json({
      data: mapped,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching history' });
  }
};

exports.getAdminStats = async (req, res) => {
  try {
    const [total, defective] = await Promise.all([
      Inspection.countDocuments(),
      Inspection.countDocuments({ label: 'defective' })
    ]);
    const efficiency = total > 0 ? (((total - defective) / total) * 100).toFixed(1) : 100;

    res.json({
      totalInspected: total,
      defective: defective,
      efficiency: Number(efficiency)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching stats' });
  }
};

// Analytics aggregation endpoint
exports.getAnalytics = async (req, res) => {
  try {
    const range = req.query.range || '30d';
    let dateFrom;
    const now = new Date();

    switch (range) {
      case '7d': dateFrom = new Date(now - 7 * 86400000); break;
      case '30d': dateFrom = new Date(now - 30 * 86400000); break;
      case '90d': dateFrom = new Date(now - 90 * 86400000); break;
      default: dateFrom = null; // all time
    }

    const matchStage = dateFrom ? { timestamp: { $gte: dateFrom } } : {};

        // Run all aggregations in parallel — single pass aggregation for KPIs + daily trend
    const [
      mainAgg,
      dailyTrend,
      confidenceDistribution,
      defectTypeBreakdown,
      recentInspection
    ] = await Promise.all([
      // One aggregation to get total, defective, avg confidence
      Inspection.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            defective: { $sum: { $cond: [{ $eq: ['$label', 'defective'] }, 1, 0] } },
            avgConf: { $avg: '$confidence' }
          }
        }
      ]),
      Inspection.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            total: { $sum: 1 },
            passed: { $sum: { $cond: [{ $eq: ['$label', 'OK'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $ne: ['$label', 'OK'] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Inspection.aggregate([
        { $match: matchStage },
        {
          $bucket: {
            groupBy: '$confidence',
            boundaries: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 101],
            default: 'Other',
            output: { count: { $sum: 1 } }
          }
        }
      ]),
      Inspection.aggregate([
        { $match: { ...matchStage, label: 'defective' } },
        { $group: { _id: '$device', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Inspection.findOne(matchStage).sort({ timestamp: -1 })
    ]);

    const totalDocs = mainAgg[0]?.total || 0;
    const defectiveDocs = mainAgg[0]?.defective || 0;
    const avgConfidenceResult = mainAgg[0]?.avgConf || 0;

    const passRate = totalDocs > 0 ? ((totalDocs - defectiveDocs) / totalDocs * 100) : 0;
    const avgConfidence = avgConfidenceResult <= 1 ? avgConfidenceResult * 100 : avgConfidenceResult;

    // Previous period for trend comparison
    let prevTotal = 0, prevDefective = 0, prevAvgConf = 0;
    if (dateFrom) {
      const periodMs = now - dateFrom;
      const prevFrom = new Date(dateFrom - periodMs);
      const prevMatch = { timestamp: { $gte: prevFrom, $lt: dateFrom } };
      const [prevAgg] = await Promise.all([
        Inspection.aggregate([
          { $match: prevMatch },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              defective: { $sum: { $cond: [{ $eq: ['$label', 'defective'] }, 1, 0] } },
              avgConf: { $avg: '$confidence' }
            }
          }
        ])
      ]);
      prevTotal = prevAgg[0]?.total || 0;
      prevDefective = prevAgg[0]?.defective || 0;
      const rawPrevConf = prevAgg[0]?.avgConf || 0;
      prevAvgConf = rawPrevConf <= 1 ? rawPrevConf * 100 : rawPrevConf;
    }

    res.json({
      kpis: {
        totalInspections: totalDocs,
        passRate: Math.round(passRate * 10) / 10,
        avgConfidence: Math.round(avgConfidence * 10) / 10,
        defective: defectiveDocs,
        trends: {
          totalChange: prevTotal > 0 ? Math.round((totalDocs - prevTotal) / prevTotal * 100) : null,
          passRateChange: prevTotal > 0
            ? Math.round(((totalDocs - defectiveDocs) / totalDocs * 100 - (prevTotal - prevDefective) / prevTotal * 100) * 10) / 10
            : null,
          confidenceChange: prevAvgConf > 0
            ? Math.round((avgConfidence - prevAvgConf) * 10) / 10
            : null
        }
      },
      dailyTrend,
      confidenceDistribution,
      defectTypeBreakdown,
      lastInspection: recentInspection ? {
        id: recentInspection._id,
        label: recentInspection.label,
        confidence: recentInspection.confidence,
        timestamp: recentInspection.timestamp,
        device: recentInspection.device
      } : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching analytics' });
  }
};

exports.getWorkerDashboardData = async (req, res) => {
  try {
    const [recent, totalInspected, defectiveCount] = await Promise.all([
      Inspection.find().sort({ timestamp: -1 }).limit(50),
      Inspection.countDocuments(),
      Inspection.countDocuments({ label: 'defective' })
    ]);
    const mapped = recent.map(h => ({
      id: h._id,
      label: h.label,
      confidence: h.confidence,
      timestamp: h.timestamp,
      processing_time: h.processing_time
    }));
    const conformingCount = totalInspected - defectiveCount;
    res.json({
      gauges: {
        totalInspected,
        defective: defectiveCount,
        conforming: conformingCount
      },
      history: mapped
    })
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching worker dashboard' });
  }
};

exports.cleanTestData = async (req, res) => {
  try {
    const result = await Inspection.deleteMany({});
    console.log(`[Admin] Cleared ${result.deletedCount} inspection records`);
    res.json({ success: true, deleted: result.deletedCount, message: `Deleted ${result.deletedCount} inspection records` });
  } catch (err) {
    console.error('Error cleaning inspection data:', err);
    res.status(500).json({ success: false, message: 'Error cleaning inspection data' });
  }
};

exports.logInspection = async (req, res) => {
  try {
    const { label, confidence, device, processing_time } = req.body;
    
    if (!label || confidence === undefined) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Accept label formats commonly used
    let normalizedLabel = 'OK';
    if (label.toLowerCase() === 'defective' || label.toLowerCase() === 'fail' || label.toLowerCase() === 'nok') {
      normalizedLabel = 'defective';
    }

    const inspection = new Inspection({
      label: normalizedLabel,
      confidence: Number(confidence),
      device: device || 'Camera 1',
      processing_time: Number(processing_time) || 0
    });

    await inspection.save();

    // Emit live event to all connected clients
    if (req.io) {
      req.io.emit('inspectionAlert', {
        id: inspection._id,
        type: normalizedLabel === 'OK' ? 'NORMAL' : 'defective',
        message: normalizedLabel === 'OK' ? 'Conforming product detected' : 'Defective product detected',
        confidence: inspection.confidence,
        processing_time: inspection.processing_time,
        device: inspection.device,
        timestamp: inspection.timestamp
      });
    }

    res.status(201).json({ success: true, data: inspection });
  } catch (err) {
    console.error('Error logging inspection:', err);
    res.status(500).json({ success: false, message: 'Error logging inspection' });
  }
};