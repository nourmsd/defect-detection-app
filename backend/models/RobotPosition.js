const mongoose = require('mongoose');

const robotPositionSchema = new mongoose.Schema({
  name:   { type: String, required: true, trim: true, maxlength: 80 },
  joints: { type: [Number], required: true },   // 6 values in radians
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

module.exports = mongoose.model('RobotPosition', robotPositionSchema);
