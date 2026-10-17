require('./loadenv');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const db = require('./db');
const L = require('./lib');
const messaging = require('./messaging');
const { seedIfEmpty } = require('./seed');
const { ensureAdmin, ensureSuperAdmin } = require('./bootstrap');
const MySQLStore = require('./sessionstore');
const { startReminders } = require('./reminders');
const { requireLogin, requireRole, csrfCheck } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
// NODE_ENV=production is the live site: HTTPS-only cookies, no sample accounts, required session secret.
const PROD = process.env.NODE_ENV === 'production';
const SESSION_MS = 1000 * 60 * 60 * 8;
if (PROD && !process.env.SESSION_SECRET) {
  console.error('Set SESSION_SECRET before running in production.');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1); // the host's HTTPS proxy sits in front, so req.ip and secure cookies work

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    // The pages use small inline scripts, so script-src is not restricted; these directives still block framing, plugins and form hijacking.
    'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
app.get('/healthz', async (req, res) => {
  try { await db.ping(); res.type('text').send('ok'); }
  catch (e) { res.status(503).type('text').send('database unavailable'); }
});
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

if (!PROD && !process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set. Using a development secret. Set one before you deploy.');
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    store: new MySQLStore(SESSION_MS),
    // No maxAge: a browser-session cookie, so closing the browser signs the user out. SESSION_MS still caps the server-side lifetime.
    cookie: { httpOnly: true, sameSite: 'lax', secure: PROD },
  })
);

// Per-request setup: CSRF token, flash message, current user, helpers for the views.
app.use(async (req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.csrf = req.session.csrf;
  res.locals.L = L;
  res.locals.showDemo = !PROD;
  res.locals.path = req.path;
  res.locals.user = null;
  res.locals.workspace = null;
  res.locals.unread = 0;
  res.locals.unreadMsgs = 0;
  if (req.session.userId) {
    const u = await db.get('SELECT id, name, email, role, active, workspace_id, avatar, student_no FROM users WHERE id = ?', [req.session.userId]);
    if (u && u.active) {
      req.user = u;
      res.locals.user = u;
      res.locals.workspace = u.workspace_id ? await db.get('SELECT id, name, join_code, active FROM workspaces WHERE id = ?', [u.workspace_id]) : null;
      if (res.locals.workspace && !res.locals.workspace.active) {
        // The system administrator suspended this workspace: nobody in it can use the site until it is switched back on.
        delete req.session.userId;
        req.user = null;
        res.locals.user = null;
        res.locals.workspace = null;
        req.flash('error', 'This workspace is suspended. Contact the system administrator.');
        res.locals.flash = req.session.flash;
        return next();
      }
      res.locals.unread = (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [u.id])).n;
      res.locals.unreadMsgs = await messaging.unreadCount(u);
    } else {
      delete req.session.userId;
    }
  }
  next();
});

// Forms that are not file uploads are checked here. Upload routes check after multer has read the body.
app.use((req, res, next) => {
  if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('multipart/')) return csrfCheck(req, res, next);
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/shared'));
app.use('/ai', require('./routes/ai'));
app.use('/messages', requireRole('student', 'adviser', 'admin'), require('./routes/messages'));
app.use('/student', requireRole('student'), require('./routes/student'));
app.use('/adviser', requireRole('adviser'), require('./routes/adviser'));
app.use('/admin', requireRole('admin'), require('./routes/admin'));
app.use('/system', requireRole('superadmin'), require('./routes/system'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
app.use((err, req, res, next) => {
  console.error(err);
  // Errors from earlier middleware (e.g. the session store) happen before the per-request locals are set.
  const l = res.locals;
  if (l.user === undefined) l.user = null;
  if (l.workspace === undefined) l.workspace = null;
  if (l.unread === undefined) l.unread = 0;
  if (l.unreadMsgs === undefined) l.unreadMsgs = 0;
  if (l.path === undefined) l.path = req.path;
  if (l.flash === undefined) l.flash = null;
  if (l.csrf === undefined) l.csrf = '';
  if (l.L === undefined) l.L = L;
  if (l.showDemo === undefined) l.showDemo = !PROD;
  const dbDown = ['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'ENOTFOUND', 'ER_CON_COUNT_ERROR'].includes(err.code) ||
    (err.errors || []).some((e) => e.code === 'ECONNREFUSED');
  if (dbDown) {
    return res.status(503).render('error', { title: 'Service unavailable', message: 'The database is not reachable right now. Please try again in a minute. If you run this system yourself, start MySQL in the XAMPP Control Panel.' });
  }
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong on the server. Check the terminal for details.' });
});

(async () => {
  try {
    await db.init();
    if (PROD) await ensureAdmin();
    else if (await seedIfEmpty()) console.log('First run: sample data created. Every sample account uses the password "password123".');
    await ensureSuperAdmin();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  startReminders();
  app.listen(PORT, () => console.log(`ThesisTrack is running at http://localhost:${PORT} (MySQL database "${db.DB_NAME}")`));
})();
