const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const roleMiddleware = require('../middleware/role');
const inspectionController = require('../controllers/inspectionController');

// All inspection routes require authentication
router.use(authMiddleware);

// Admin routes
router.get('/admin/stats', roleMiddleware(['admin']), inspectionController.getAdminStats);
router.get('/admin/history', roleMiddleware(['admin']), inspectionController.getHistory);

// Shared or worker routes
router.get('/worker/dashboard-data', roleMiddleware(['worker', 'admin']), inspectionController.getWorkerDashboardData);
router.get('/inspections', inspectionController.getHistory);

module.exports = router;
