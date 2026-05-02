const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const {
  getRobotStatus,
  receiveActionResult,
  enableFreemotion,
  disableFreemotion,
  getCurrentJoints,
  savePosition,
  getPositions,
  deletePosition,
  rebootTool,
  rebootMotors,
  calibrate,
  emergencyStop,
} = require('../controllers/robotController');

// Called by niryo_pick_place.py (no auth — internal service)
router.post('/action-result', receiveActionResult);

// All other routes require a logged-in user
router.use(authMiddleware);

router.get('/status',             getRobotStatus);
router.post('/freemotion/enable', enableFreemotion);
router.post('/freemotion/disable',disableFreemotion);
router.get('/current-joints',     getCurrentJoints);

router.get('/positions',          getPositions);
router.post('/positions',         savePosition);
router.delete('/positions/:id',   deletePosition);

router.post('/reboot-tool',       rebootTool);
router.post('/reboot-motors',     rebootMotors);
router.post('/calibrate',         calibrate);
router.post('/emergency-stop',    emergencyStop);

module.exports = router;
