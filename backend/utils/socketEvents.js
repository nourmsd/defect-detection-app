const ALLOWED_EVENT_TYPES = new Set([
  'inspection',
  'robot_alert',
  'system_health',
  'inference_status',
  'attendance_update',  // worker login / logout
  'system_timeline',   // factory timeline state change
  'error_log',         // system error/fault logged
  'danger_alert',      // critical danger — triggers email + in-app alert
]);

function emitSocketEvent(io, type, payload) {
  if (!io || !ALLOWED_EVENT_TYPES.has(type)) {
    return;
  }

  io.emit('event', {
    type,
    payload,
  });
}

module.exports = {
  ALLOWED_EVENT_TYPES,
  emitSocketEvent,
};
