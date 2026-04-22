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
  device: {
    type: String,
    default: 'Camera 1'
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

// Indexes to avoid full collection scans on every query
inspectionSchema.index({ timestamp: -1 });
inspectionSchema.index({ label: 1, timestamp: -1 });

module.exports = mongoose.model('Inspection', inspectionSchema);
