const Inspection = require('../models/Inspection');

exports.getHistory = async (req, res) => {
  try {
    const history = await Inspection.find().sort({ timestamp: -1 }).limit(100);
    // map _id to id to keep compatibility with frontend models
    const mapped = history.map(h => ({
      id: h._id,
      label: h.label,
      confidence: h.confidence,
      timestamp: h.timestamp,
      device: h.device
    }));
    res.json(mapped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching history' });
  }
};

exports.getAdminStats = async (req, res) => {
  try {
    const total = await Inspection.countDocuments();
    const defective = await Inspection.countDocuments({ label: 'defective' });
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

exports.getWorkerDashboardData = async (req, res) => {
  try {
    const recent = await Inspection.find().sort({ timestamp: -1 }).limit(10);
    const mapped = recent.map(h => ({
      id: h._id,
      label: h.label,
      confidence: h.confidence,
      timestamp: h.timestamp
    }));
    res.json(mapped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching worker data' });
  }
};
