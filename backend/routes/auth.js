const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const roleMiddleware = require('../middleware/role');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/reset-password', authController.resetPassword);

// Admin validation routes
router.get('/pending-workers', authMiddleware, roleMiddleware(['admin']), authController.getPendingWorkers);
router.post('/validate-worker', authMiddleware, roleMiddleware(['admin']), authController.validateWorker);

// Admin workers availability
router.get('/admin/active-workers', authMiddleware, roleMiddleware(['admin']), authController.getActiveWorkers);

module.exports = router;
router.get('/admin/all-users', authMiddleware, roleMiddleware(['admin']), authController.getAllUsers);
router.delete('/admin/delete-user/:userId', authMiddleware, roleMiddleware(['admin']), authController.deleteUser);
