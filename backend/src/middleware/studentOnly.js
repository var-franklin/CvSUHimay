const studentOnly = (req, res, next) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'ACCESS_DENIED', message: 'Student only.' });
  }
  next();
};

module.exports = studentOnly;
