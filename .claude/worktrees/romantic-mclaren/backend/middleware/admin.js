const roleMiddleware = require('./role');

module.exports = (req, res, next) => {
  // We reuse the roleMiddleware logic but specifically for 'admin'
  return roleMiddleware(['admin'])(req, res, next);
};
