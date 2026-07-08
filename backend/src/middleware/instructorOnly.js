const instructorOnly = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role !== 'instructor') {
    return res.status(403).json({ error: 'Access denied. Instructor only.' });
  }
  next();
};

module.exports = instructorOnly;
