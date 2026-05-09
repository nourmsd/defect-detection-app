const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const roleMiddleware = require('../middleware/role');
const inspectionController = require('../controllers/inspectionController');

// Open route for robot hardware to POST logs
router.post('/robot-log', inspectionController.logInspection);

// All inspection routes require authentication
router.use(authMiddleware);

// Admin routes
router.get('/admin/stats', roleMiddleware(['supervisor']), inspectionController.getAdminStats);
router.get('/admin/history', roleMiddleware(['supervisor', 'worker']), inspectionController.getHistory);
router.get('/admin/analytics', roleMiddleware(['supervisor']), inspectionController.getAnalytics);
router.delete('/admin/clean-test-data', roleMiddleware(['supervisor']), inspectionController.cleanTestData);

// Shared or worker routes
router.get('/worker/dashboard-data', roleMiddleware(['worker', 'supervisor']), inspectionController.getWorkerDashboardData);
router.get('/inspections', inspectionController.getHistory);

module.exports = router;

