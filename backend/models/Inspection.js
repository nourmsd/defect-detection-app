const mongoose = require('mongoose');

const inspectionSchema = new mongoose.Schema({
  inspection_id: {
    type: String,
    index: true,
    default: null
  },
  label: {
    type: String,
    enum: ['ok', 'defective'],
    required: true
  },
  defect_type: {
    type: String,
    enum: ['absent', 'blurry', 'expired', null],
    default: null
  },
  flavor: {
    type: String,
    default: 'missing'
  },
  expiry_date: {
    type: String,
    default: 'missing'
  },
  barcode: {
    type: String,
    default: 'missing',
    index: true
  },
  confidence: {
    type: Number,
    required: true
  },
  processing_time: {
    type: Number,
    default: 0
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

inspectionSchema.index({ timestamp: -1 });
inspectionSchema.index({ label: 1, timestamp: -1 });
inspectionSchema.index({ defect_type: 1, timestamp: -1 });

module.exports = mongoose.model('Inspection', inspectionSchema);
