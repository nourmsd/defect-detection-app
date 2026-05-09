const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const roleMiddleware = require('../middleware/role');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/logout', authMiddleware, authController.logout);
router.post('/reset-password', authController.resetPassword);

// Admin validation routes
router.get('/pending-workers', authMiddleware, roleMiddleware(['supervisor']), authController.getPendingWorkers);
router.post('/validate-worker', authMiddleware, roleMiddleware(['supervisor']), authController.validateWorker);

// Admin workers availability
router.get('/admin/active-workers', authMiddleware, roleMiddleware(['supervisor']), authController.getActiveWorkers);

// User management
router.get('/admin/all-users', authMiddleware, roleMiddleware(['supervisor']), authController.getAllUsers);
router.delete('/admin/delete-user/:userId', authMiddleware, roleMiddleware(['supervisor']), authController.deleteUser);

module.exports = router;

