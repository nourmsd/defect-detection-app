const mongoose = require('mongoose');

const attendanceLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fullName: { type: String, default: '' },
  username: { type: String, required: true },
  email: { type: String, required: true },
  role: { type: String, required: true },
  loginTime: { type: Date, required: true },
  logoutTime: { type: Date, default: null },
  sessionDuration: { type: Number, default: 0 }, // minutes
  date: { type: String, required: true, index: true }  // YYYY-MM-DD
});

attendanceLogSchema.index({ userId: 1, loginTime: -1 });
attendanceLogSchema.index({ date: 1, userId: 1 });

module.exports = mongoose.model('AttendanceLog', attendanceLogSchema);
