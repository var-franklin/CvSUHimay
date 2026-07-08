const instructorOrAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role !== 'instructor' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Instructor or admin only.' });
  }
  next();
};

module.exports = instructorOrAdmin;
