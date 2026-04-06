const Inspection = require('../models/Inspection');

exports.getHistory = async (req, res) => {
  try {
    const history = await Inspection.find().sort({ timestamp: -1 }).limit(100);
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
    const recent = await Inspection.find().sort({ timestamp: -1 }).limit(20);
    const mapped = recent.map(h => ({
      id: h._id,
      label: h.label,
      confidence: h.confidence,
      timestamp: h.timestamp,
      device: h.device
    }));
    res.json(mapped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching worker data' });
  }
};

exports.getWorkerStats = async (req, res) => {
  try {
    const total = await Inspection.countDocuments();
    const ok = await Inspection.countDocuments({ label: 'OK' });
    const defective = await Inspection.countDocuments({ label: 'defective' });
    const defectRate = total > 0 ? Math.round((defective / total) * 100) : 0;

    // Get today's stats
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTotal = await Inspection.countDocuments({ timestamp: { $gte: todayStart } });
    const todayDefective = await Inspection.countDocuments({ label: 'defective', timestamp: { $gte: todayStart } });
    const todayOk = todayTotal - todayDefective;

    // Get last hour stats
    const lastHour = new Date(Date.now() - 3600000);
    const hourTotal = await Inspection.countDocuments({ timestamp: { $gte: lastHour } });

    res.json({
      total,
      ok,
      defective,
      defectRate,
      today: { total: todayTotal, ok: todayOk, defective: todayDefective },
      lastHourCount: hourTotal
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching worker stats' });
  }
};

exports.createInspection = async (req, res) => {
  try {
    const { label, confidence, device } = req.body;

    if (!label || confidence === undefined) {
      return res.status(400).json({ message: 'label and confidence are required' });
    }

    const inspection = new Inspection({
      label,
      confidence,
      device: device || 'Camera 1'
    });

    await inspection.save();

    const mapped = {
      id: inspection._id,
      label: inspection.label,
      confidence: inspection.confidence,
      timestamp: inspection.timestamp,
      device: inspection.device
    };

    // Emit real-time events via Socket.io
    const io = req.app.get('io');
    if (io) {
      io.emit('newInspection', mapped);

      if (label === 'defective') {
        io.emit('alert', {
          type: 'defective',
          message: `Defect detected! Confidence: ${confidence}% - ${device || 'Camera 1'}`,
          inspection: mapped
        });
      }
    }

    res.status(201).json(mapped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error creating inspection' });
  }
};
