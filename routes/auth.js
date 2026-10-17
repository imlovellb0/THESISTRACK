const router = require('express').Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const mailer = require('../mailer');
const L = require('../lib');
const { homeFor, csrfCheck } = require('../middleware');
const { looksLikeImage } = require('../imagecheck');

// Simple in-memory brake on password guessing: 10 failed logins per IP per 15 minutes.
const fails = new Map();
const blocked = (ip) => {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 15 * 60 * 1000) { fails.delete(ip); return false; }
  return f.n >= 10;
};
const fail = (ip) => {
  const f = fails.get(ip) || { n: 0, since: Date.now() };
  f.n++;
  fails.set(ip, f);
};

function startSession(req, res, user, welcome) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    if (welcome) req.flash(welcome.type, welcome.msg);
    res.redirect(returnTo && returnTo.startsWith('/') ? returnTo : homeFor(user));
  });
}

router.get('/', (req, res) => res.redirect(req.user ? homeFor(req.user) : '/login'));

// Join codes are typed by hand, so spaces, dashes and lower case are forgiven.
const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.set('Cache-Control', 'no-store'); // stops the back button from restoring a filled-in form
  res.render('login', { title: 'Sign in' });
});

router.post('/login', async (req, res) => {
  const ip = req.ip;
  if (blocked(ip)) {
    req.flash('error', 'Too many failed attempts. Wait 15 minutes and try again.');
    return res.redirect('/login');
  }
  const email = String(req.body.email || '').trim();
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (user && user.role === 'panel') {
    req.flash('error', 'Panel members do not sign in. The coordinator records them and assigns them to groups.');
    return res.redirect('/login');
  }
  // System administrators sign in on their own unlisted page, so this form treats their account as unknown.
  if (!user || user.role === 'superadmin' || !user.active || !await bcrypt.compare(String(req.body.password || ''), user.password_hash)) {
    fail(ip);
    req.flash('error', 'Wrong email or password, or the account is inactive.');
    return res.redirect('/login');
  }
  if (user.workspace_id && !(await db.get('SELECT 1 FROM workspaces WHERE id = ? AND active = 1', [user.workspace_id]))) {
    req.flash('error', 'This workspace is suspended. Contact the system administrator.');
    return res.redirect('/login');
  }
  // The role picked on the form must match the account, so a student cannot sign in as a coordinator by mistake.
  if (req.body.role && req.body.role !== user.role) {
    req.flash('error', `This account is not a ${L.ROLE_LABEL[req.body.role]?.toLowerCase() || 'member of that role'}. Choose the right role and try again.`);
    return res.redirect('/login');
  }
  fails.delete(ip);
  startSession(req, res, user);
});

// The system administrator's own sign-in page. It is not linked from anywhere, and it answers every failure the same way.
router.get('/system/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.set('Cache-Control', 'no-store');
  res.render('system-login', { title: 'System sign in' });
});

router.post('/system/login', async (req, res) => {
  const ip = req.ip;
  if (blocked(ip)) {
    req.flash('error', 'Too many failed attempts. Wait 15 minutes and try again.');
    return res.redirect('/system/login');
  }
  const user = await db.get("SELECT * FROM users WHERE email = ? AND role = 'superadmin' AND active = 1", [String(req.body.email || '').trim()]);
  if (!user || !await bcrypt.compare(String(req.body.password || ''), user.password_hash)) {
    fail(ip);
    req.flash('error', 'Wrong email or password.');
    return res.redirect('/system/login');
  }
  fails.delete(ip);
  startSession(req, res, user);
});

router.post('/logout', (req, res) => {
  // A system administrator goes back to their own sign-in page, everyone else to the normal one.
  const to = req.user && req.user.role === 'superadmin' ? '/system/login' : '/login';
  req.session.destroy(() => res.redirect(to));
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('register', { title: 'Create student account', form: { join_code: cleanCode(req.query.code) } });
});

// ---------- adviser registration: only with the coordinator's invitation and the code emailed to the invited address ----------
const MAX_OTP_TRIES = 5;

router.get('/register/adviser', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('register-adviser', { title: 'Adviser registration', form: {} });
});

router.post('/register/adviser', async (req, res) => {
  const ip = req.ip;
  const email = String(req.body.email || '').trim().toLowerCase();
  const otp = String(req.body.otp || '').trim();
  const password = String(req.body.password || '');
  const error = (msg, status = 400) => res.status(status).render('register-adviser', { title: 'Adviser registration', form: { email }, error: msg });
  const BAD = 'That email and code do not match an open invitation, or the code has expired. Ask the coordinator to send a new code.';

  if (blocked(ip)) return error('Too many failed attempts. Wait 15 minutes and try again.', 429);
  if (password.length < 8) return error('Use a password with at least 8 characters.');
  if (password !== req.body.confirm) return error('The two passwords do not match.');

  const inv = await db.get("SELECT * FROM adviser_invites WHERE email = ? AND status = 'Invited' AND expires_at > NOW() ORDER BY id DESC LIMIT 1", [email]);
  if (!inv) { fail(ip); return error(BAD); }
  if (inv.attempts >= MAX_OTP_TRIES) return error('Too many wrong codes for this invitation. Ask the coordinator to send a new code.');
  if (!/^\d{6}$/.test(otp) || !await bcrypt.compare(otp, inv.otp_hash)) {
    await db.run('UPDATE adviser_invites SET attempts = attempts + 1 WHERE id = ?', [inv.id]); // 5 wrong codes lock this invitation
    return error(BAD);
  }
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return error('That email already has an account. Sign in instead.');

  // The role, name and email come from the coordinator's invitation, not from this form.
  const userId = await db.transaction(async () => {
    const info = await db.run("INSERT INTO users (name, email, password_hash, role, workspace_id) VALUES (?, ?, ?, 'adviser', ?)", [inv.name, inv.email, await bcrypt.hash(password, 10), inv.workspace_id]);
    await db.run("UPDATE adviser_invites SET status = 'Registered', used_at = NOW() WHERE id = ?", [inv.id]);
    return info.lastInsertRowid;
  });
  await L.log(userId, 'registered as an adviser with an invitation code');
  fails.delete(ip);
  startSession(req, res, { id: userId, role: 'adviser' });
});

// ---------- coordinator registration: only with an invitation code from the system administrator ----------
// The code is single-use, belongs to one email address, and expires. The system administrator can also close this page.
const COORD_TRIES = 5;
const closedPage = (res) => res.status(403).render('error', { title: 'Registration closed', message: 'New coordinator accounts are paused right now. Contact the system administrator.' });
const signupClosed = async () => (await db.getSetting('coordinator_signup', 'on')) !== 'on';

router.get('/register/coordinator', async (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  if (await signupClosed()) return closedPage(res);
  res.render('register-coordinator', { title: 'Coordinator registration', form: { email: String(req.query.email || '').trim().toLowerCase().slice(0, 190), code: cleanCode(req.query.code) } });
});

router.post('/register/coordinator', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const workspaceName = String(req.body.workspace || '').trim().slice(0, 120);
  const password = String(req.body.password || '');
  const code = cleanCode(req.body.code);
  if (await signupClosed()) return closedPage(res);
  const error = (msg, status = 400) =>
    res.status(status).render('register-coordinator', { title: 'Coordinator registration', form: { name, email, workspace: workspaceName, code }, error: msg });
  const BAD = 'That email and code do not match an open invitation, or the code has expired. Ask the system administrator for a new code.';

  if (blocked(req.ip)) return error('Too many failed attempts. Wait 15 minutes and try again.', 429);
  if (!workspaceName) return error('Give your workspace a name, for example "BSIT 4A Thesis, AY 2026-27".');
  if (!name) return error('Enter your full name.');
  if (password.length < 8) return error('Use a password with at least 8 characters.');
  if (password !== req.body.confirm) return error('The two passwords do not match.');
  if (req.body.consent !== 'on') return error('Tick the box to agree to the Privacy Notice.');

  const inv = await db.get("SELECT * FROM coordinator_invites WHERE email = ? AND status = 'Invited' AND expires_at > NOW() ORDER BY id DESC LIMIT 1", [email]);
  if (!inv) { fail(req.ip); return error(BAD); }
  if (inv.attempts >= COORD_TRIES) return error('Too many wrong codes for this invitation. Ask the system administrator for a new code.');
  if (code.length < 8 || !await bcrypt.compare(code, inv.code_hash)) {
    await db.run('UPDATE coordinator_invites SET attempts = attempts + 1 WHERE id = ?', [inv.id]); // 5 wrong codes lock this invitation
    fail(req.ip);
    return error(BAD);
  }
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return error('That email is already registered.');

  const userId = await db.transaction(async () => {
    const ws = await db.createWorkspace(workspaceName);
    const info = await db.run(
      "INSERT INTO users (name, email, password_hash, role, consent_at, workspace_id) VALUES (?, ?, ?, 'admin', NOW(), ?)",
      [name, email, await bcrypt.hash(password, 10), ws.id]
    );
    await db.run("UPDATE coordinator_invites SET status = 'Registered', used_at = NOW() WHERE id = ?", [inv.id]);
    return info.lastInsertRowid;
  });
  await L.log(userId, `created the workspace ${workspaceName} with an invitation code`);
  fails.delete(req.ip);
  startSession(req, res, { id: userId, role: 'admin' });
});

// ---------- student ID photo: JPG, PNG or WEBP up to 5 MB, saved under a random name ----------
const PHOTO_TYPES = ['.jpg', '.jpeg', '.png', '.webp'];
const idPhoto = multer({
  storage: multer.diskStorage({
    destination: db.UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, 'id-' + crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    PHOTO_TYPES.includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('WRONG_TYPE')),
});
const removeFile = (file) => file && fs.rmSync(file.path, { force: true });

// Only students can register themselves. Advisers, panel members and the coordinator are added by the coordinator.
router.post(
  '/register',
  (req, res, next) =>
    idPhoto.single('id_photo')(req, res, (err) => {
      if (!err) return next();
      req.uploadError = err.message === 'WRONG_TYPE' ? 'Use a JPG, PNG or WEBP photo of your ID.'
        : err.code === 'LIMIT_FILE_SIZE' ? 'The photo is larger than 5 MB.' : 'The photo upload failed. Try again.';
      next();
    }),
  csrfCheck,
  async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 255);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
    const studentNo = String(req.body.student_no || '').trim().slice(0, 30);
    const password = String(req.body.password || '');
    const consent = req.body.consent === 'on';
    const joinCode = cleanCode(req.body.join_code);
    const error = (msg) => {
      removeFile(req.file);
      return res.status(400).render('register', { title: 'Create student account', form: { name, email, student_no: studentNo, join_code: joinCode }, error: msg });
    };
    if (req.uploadError) return error(req.uploadError);
    const workspace = joinCode && await db.get('SELECT id FROM workspaces WHERE join_code = ? AND active = 1', [joinCode]);
    if (!workspace) return error('That join code is not valid. Ask your thesis coordinator for the code.');
    if (!consent) return error('Tick the box to agree to the Privacy Notice.');
    if (!name) return error('Enter your full name.');
    if (!/^[A-Za-z0-9][A-Za-z0-9\-\/]{2,29}$/.test(studentNo)) return error('Enter your student ID number (letters, numbers and dashes, at least 3 characters).');
    if (!/^\S+@\S+\.\S+$/.test(email)) return error('Enter a valid email address.');
    if (password.length < 8) return error('Use a password with at least 8 characters.');
    if (password !== req.body.confirm) return error('The two passwords do not match.');
    if (!req.file) return error('Take or upload a photo of your student ID.');
    if (!looksLikeImage(req.file)) return error('That file is not a valid image. Take or upload a photo of your ID.');
    if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return error('That email is already registered.');
    if (await db.get('SELECT 1 FROM users WHERE student_no = ?', [studentNo])) return error('That student ID number is already registered.');
    const info = await db.run(
      "INSERT INTO users (name, email, password_hash, role, student_no, id_photo, consent_at, workspace_id) VALUES (?, ?, ?, 'student', ?, ?, NOW(), ?)",
      [name, email, await bcrypt.hash(password, 10), studentNo, req.file.filename, workspace.id]
    );
    await L.log(info.lastInsertRowid, 'created a student account');
    // If a group leader had invited this email, the student joins that group straight away.
    const joined = await L.claimInvites(info.lastInsertRowid, email, workspace.id);
    startSession(req, res, { id: info.lastInsertRowid, role: 'student' }, joined ? { type: 'ok', msg: `You were invited to ${joined} and joined it automatically.` } : null);
  }
);

// ---------- forgotten password: a one-time link by email (or in outbox/mail.log when email is not set up) ----------
const RESET_MINUTES = 30;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const asked = new Map(); // at most 5 reset requests per IP per 15 minutes
const tooMany = (ip) => {
  const a = asked.get(ip);
  if (!a || Date.now() - a.since > 15 * 60 * 1000) { asked.set(ip, { n: 1, since: Date.now() }); return false; }
  return ++a.n > 5;
};
const validReset = (token) =>
  db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()', [sha(String(token))]);

router.get('/forgot', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('forgot', { title: 'Forgot password', sent: false });
});

router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (tooMany(req.ip)) return res.status(429).render('forgot', { title: 'Forgot password', sent: false, error: 'Too many requests. Wait 15 minutes and try again.' });
  const user = await db.get("SELECT * FROM users WHERE email = ? AND active = 1 AND role != 'panel'", [email]);
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ${RESET_MINUTES} MINUTE))`, [user.id, sha(token)]);
    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    try {
      await mailer.send({
        to: user.email,
        subject: 'Reset your ThesisTrack password',
        text: `Hello ${user.name},\n\nOpen this link to choose a new password. It works once and expires in ${RESET_MINUTES} minutes:\n\n${base}/reset/${token}\n\nIf you did not ask for this, ignore this email. Your password stays the same.\n`,
      });
    } catch (e) { console.error(e); }
    await L.log(user.id, 'asked for a password reset link');
    // Password help belongs to the system administrator, not the coordinator, so they are told right away.
    for (const a of await db.all("SELECT id FROM users WHERE role = 'superadmin' AND active = 1 AND id != ?", [user.id])) {
      await L.notify(a.id, `${user.name} (${L.ROLE_LABEL[user.role].toLowerCase()}) asked for a password reset. If they cannot use the emailed link, reset it for them.`, `/system/users/${user.id}`, 'system');
    }
  }
  // The same answer whether or not the email exists, so nobody can test which emails are registered.
  res.render('forgot', { title: 'Forgot password', sent: true, mailReady: mailer.configured() });
});

router.get('/reset/:token', async (req, res) => {
  if (!(await validReset(req.params.token))) return res.status(400).render('error', { title: 'Link expired', message: 'This reset link is invalid, already used or expired. Ask for a new one on the Forgot password page.' });
  res.render('reset', { title: 'Choose a new password', token: req.params.token });
});

router.post('/reset/:token', async (req, res) => {
  const r = await validReset(req.params.token);
  if (!r) return res.status(400).render('error', { title: 'Link expired', message: 'This reset link is invalid, already used or expired. Ask for a new one on the Forgot password page.' });
  const password = String(req.body.password || '');
  const back = (msg) => res.status(400).render('reset', { title: 'Choose a new password', token: req.params.token, error: msg });
  if (password.length < 8) return back('Use a password with at least 8 characters.');
  if (password !== req.body.confirm) return back('The two passwords do not match.');
  const hash = await bcrypt.hash(password, 10);
  await db.transaction(async () => {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, r.user_id]);
    await db.run('UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [r.user_id]);
  });
  await L.log(r.user_id, 'reset their password with an emailed link');
  req.flash('ok', 'Your password was changed. Sign in with the new one.');
  res.redirect('/login');
});

module.exports = router;
