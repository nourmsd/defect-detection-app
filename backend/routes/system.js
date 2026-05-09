const express = require('express');
const router = express.Router();
const systemController = require('../controllers/systemController');
const authMiddleware = require('../middleware/auth');
const roleMiddleware = require('../middleware/role');

// System settings (daily_target, expiry_threshold)
router.get('/admin/settings', authMiddleware, roleMiddleware(['supervisor']), systemController.getSettings);
router.put('/admin/settings', authMiddleware, roleMiddleware(['supervisor']), systemController.updateSettings);

// System timeline (daily 07:00â€“19:00 state log)
router.get('/admin/timeline', authMiddleware, roleMiddleware(['supervisor']), systemController.getTimeline);
router.post('/admin/timeline/event', authMiddleware, roleMiddleware(['supervisor']), systemController.postTimelineEvent);

// Error logs (accessible by workers + admins)
router.get('/error-logs', authMiddleware, roleMiddleware(['supervisor', 'worker']), systemController.getErrorLogs);
router.put('/error-logs/:id/acknowledge', authMiddleware, roleMiddleware(['supervisor', 'worker']), systemController.acknowledgeErrorLog);
router.get('/error-logs/export', authMiddleware, roleMiddleware(['supervisor', 'worker']), systemController.exportErrorLogs);

module.exports = router;

