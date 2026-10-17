// Login, role and CSRF checks used by the routes.
const requireLogin = (req, res, next) => {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).render('error', { title: 'No access', message: 'Your account does not have access to this page.' });
  }
  next();
};

// Every form carries a hidden _csrf token. A POST without the right token is refused.
const csrfCheck = (req, res, next) => {
  if (!req.body || req.body._csrf !== req.session.csrf) {
    return res.status(403).render('error', { title: 'Session expired', message: 'Your form expired. Go back, refresh the page and try again.' });
  }
  next();
};

const homeFor = (user) => ({ student: '/student', adviser: '/adviser', admin: '/admin', superadmin: '/system' }[user.role]);

module.exports = { requireLogin, requireRole, csrfCheck, homeFor };
