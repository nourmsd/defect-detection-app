const mongoose = require('mongoose');

const timelineEventSchema = new mongoose.Schema({
  eventType: {
    type: String,
    enum: ['start', 'running', 'stopping', 'fault', 'shutdown'],
    required: true
  },
  color: { type: String, enum: ['yellow', 'green', 'red'], required: true },
  label: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const systemTimelineSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true }, // YYYY-MM-DD
  events: [timelineEventSchema]
});

module.exports = mongoose.model('SystemTimeline', systemTimelineSchema);
