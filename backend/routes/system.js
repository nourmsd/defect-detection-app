const express = require('express');
const router = express.Router();
const systemController = require('../controllers/systemController');
const authMiddleware = require('../middleware/auth');
const roleMiddleware = require('../middleware/role');

// System settings (daily_target, expiry_threshold)
router.get('/admin/settings', authMiddleware, roleMiddleware(['admin']), systemController.getSettings);
router.put('/admin/settings', authMiddleware, roleMiddleware(['admin']), systemController.updateSettings);

// System timeline (daily 07:00–19:00 state log)
router.get('/admin/timeline', authMiddleware, roleMiddleware(['admin']), systemController.getTimeline);
router.post('/admin/timeline/event', authMiddleware, roleMiddleware(['admin']), systemController.postTimelineEvent);

// Error logs (accessible by workers + admins)
router.get('/error-logs', authMiddleware, roleMiddleware(['admin', 'worker']), systemController.getErrorLogs);
router.put('/error-logs/:id/acknowledge', authMiddleware, roleMiddleware(['admin', 'worker']), systemController.acknowledgeErrorLog);

module.exports = router;
