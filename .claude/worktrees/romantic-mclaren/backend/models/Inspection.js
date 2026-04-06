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
  }
});

module.exports = mongoose.model('Inspection', inspectionSchema);
