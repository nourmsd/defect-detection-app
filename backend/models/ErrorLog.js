const mongoose = require('mongoose');

const errorLogSchema = new mongoose.Schema({
  errorType: { type: String, required: true },
  severity: {
    type: String,
    enum: ['critical', 'error', 'warning'],
    default: 'warning'
  },
  message: { type: String, required: true },
  suggestedAction: { type: String, default: '' },
  resolved: { type: Boolean, default: false },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  acknowledgedAt: { type: Date, default: null },
  timestamp: { type: Date, default: Date.now, index: true }
});

errorLogSchema.index({ severity: 1, timestamp: -1 });
errorLogSchema.index({ resolved: 1, timestamp: -1 });

module.exports = mongoose.model('ErrorLog', errorLogSchema);
