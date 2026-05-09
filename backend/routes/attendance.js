const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const authMiddleware = require('../middleware/auth');
const roleMiddleware = require('../middleware/role');

// Admin: view connected workers in real-time
router.get(
  '/admin/attendance/connected',
  authMiddleware, roleMiddleware(['supervisor']),
  attendanceController.getConnectedWorkers
);

// Admin: full attendance history (query: date, userId, range=week|day)
router.get(
  '/admin/attendance/history',
  authMiddleware, roleMiddleware(['supervisor']),
  attendanceController.getAttendanceHistory
);

module.exports = router;

