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

// Worker routes — both endpoints point to same handler for compatibility
router.get('/worker/dashboard', roleMiddleware(['worker', 'admin']), inspectionController.getWorkerDashboardData);
router.get('/worker/dashboard-data', roleMiddleware(['worker', 'admin']), inspectionController.getWorkerDashboardData);
router.get('/worker/stats', roleMiddleware(['worker', 'admin']), inspectionController.getWorkerStats);

// Shared routes
router.get('/inspections', inspectionController.getHistory);

// Create new inspection (from AI system, robot, or manual)
router.post('/inspections', inspectionController.createInspection);

module.exports = router;
