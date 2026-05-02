const mongoose = require('mongoose');

const inspectionSchema = new mongoose.Schema({
  label: {
    type: String,
    enum: ['OK', 'defective'],
    required: true
  },
  confidence: {
    type: Number,
    required: true
  },
  detected_date: {
    type: String,
    default: 'missing'   // "DD MMM" from AI classifier, or "missing" if unreadable
  },
  device: {
    type: String,
    default: 'Niryo Camera'
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  processing_time: {
    type: Number,
    default: 0
  }
});

inspectionSchema.index({ timestamp: -1 });
inspectionSchema.index({ label: 1, timestamp: -1 });

module.exports = mongoose.model('Inspection', inspectionSchema);
