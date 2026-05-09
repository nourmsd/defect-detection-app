const roleMiddleware = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Legacy 'admin' role (from before the rename) is treated as 'supervisor'.
    const rawRole = String(req.user.role || '').toLowerCase();
    const effectiveRole = rawRole === 'admin' ? 'supervisor' : rawRole;
    const allowed = roles.map(r => String(r).toLowerCase() === 'admin' ? 'supervisor' : String(r).toLowerCase());

    if (!allowed.includes(effectiveRole)) {
      return res.status(403).json({ message: 'Forbidden: Access denied' });
    }

    next();
  };
};

module.exports = roleMiddleware;
