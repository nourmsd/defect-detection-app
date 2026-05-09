const roleMiddleware = require('./role');

module.exports = (req, res, next) => {
  return roleMiddleware(['supervisor'])(req, res, next);
};
