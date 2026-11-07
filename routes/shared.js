// Pages every signed-in role uses: file downloads, notifications and the account (change password) page.
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const db = require('../db');
const L = require('../lib');
const M = require('../messaging');
const { requireLogin, csrfCheck } = require('../middleware');
const { looksLikeImage } = require('../imagecheck');
const { weakPassword, endSessions } = require('../security');
const mailer = require('../mailer');

// One announcement in full. Opened from the notification, so a person only sees announcements of their own workspace.
router.get('/announcements/:id', requireLogin, async (req, res) => {
  const a = await db.get(
    `SELECT a.*, u.name AS poster, u.role AS poster_role FROM announcements a LEFT JOIN users u ON u.id = a.posted_by
      WHERE a.id = ? AND (a.workspace_id = ? OR ? = 'superadmin')`,
    [Number(req.params.id), req.user.workspace_id || 0, req.user.role]
  );
  if (!a) return res.status(404).render('error', { title: 'Not found', message: 'That announcement does not exist or was removed.' });
  res.render('announcement', { title: a.title, a });
});

router.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy Notice' }));

// Download one uploaded version. Only people connected to that group can get it.
router.get('/files/:id', requireLogin, async (req, res) => {
  const sub = await db.get('SELECT s.*, c.group_id FROM submissions s JOIN chapters c ON c.id = s.chapter_id WHERE s.id = ?', [Number(req.params.id)]);
  if (!sub || !(await L.canAccessGroup(req.user, sub.group_id))) {
    return res.status(403).render('error', { title: 'No access', message: 'You cannot open this file.' });
  }
  const file = path.join(db.UPLOAD_DIR, path.basename(sub.stored_name));
  if (!fs.existsSync(file)) {
    return res.status(404).render('error', { title: 'File missing', message: 'The file is no longer on the server.' });
  }
  if (req.query.inline === '1' && /\.pdf$/i.test(sub.stored_name)) return sendInline(res, file, sub.original_name);
  res.download(file, sub.original_name);
});

// Shows a PDF in the page (the viewer frames this). The browser's own PDF viewer needs object-src on this response.
function sendInline(res, file, name) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Security-Policy': "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
    'Cache-Control': 'private, no-store',
  });
  res.sendFile(file);
}

// A file the adviser attached to a chapter (for example a marked-up PDF). Same people can open it as the chapter's versions.
async function markedFile(req, res) {
  const f = await db.get('SELECT f.*, c.group_id FROM adviser_files f JOIN chapters c ON c.id = f.chapter_id WHERE f.id = ?', [Number(req.params.id)]);
  if (!f || !(await L.canAccessGroup(req.user, f.group_id))) {
    res.status(403).render('error', { title: 'No access', message: 'You cannot open this file.' });
    return null;
  }
  const file = path.join(db.UPLOAD_DIR, path.basename(f.stored_name));
  if (!fs.existsSync(file)) {
    res.status(404).render('error', { title: 'File missing', message: 'The file is no longer on the server.' });
    return null;
  }
  return { f, file };
}

router.get('/marked/:id', requireLogin, async (req, res) => {
  const m = await markedFile(req, res);
  if (!m) return;
  if (req.query.inline === '1' && /\.pdf$/i.test(m.f.stored_name)) return sendInline(res, m.file, m.f.original_name);
  res.download(m.file, m.f.original_name);
});

// The viewer page for PDF (browser viewer) and DOCX (drawn in the page by docx-preview): a student version (/viewer/files/ID) or an adviser's marked file (/viewer/marked/ID).
router.get('/viewer/:kind/:id', requireLogin, async (req, res) => {
  if (!['files', 'marked'].includes(req.params.kind)) return res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  const id = Number(req.params.id);
  let name, group, stored;
  if (req.params.kind === 'files') {
    const s = await db.get('SELECT s.original_name, s.stored_name, c.group_id, c.number FROM submissions s JOIN chapters c ON c.id = s.chapter_id WHERE s.id = ?', [id]);
    if (s && /\.(pdf|docx)$/i.test(s.stored_name)) { name = s.original_name; group = s; stored = s.stored_name; }
  } else {
    const f = await db.get('SELECT f.original_name, f.stored_name, c.group_id, c.number FROM adviser_files f JOIN chapters c ON c.id = f.chapter_id WHERE f.id = ?', [id]);
    if (f && /\.(pdf|docx)$/i.test(f.stored_name)) { name = f.original_name; group = f; stored = f.stored_name; }
  }
  if (!group || !(await L.canAccessGroup(req.user, group.group_id))) {
    return res.status(403).render('error', { title: 'No access', message: 'You cannot open this file, or it cannot be shown here (only PDF and DOCX files can).' });
  }
  res.render('viewer', { title: name, name, src: `/${req.params.kind}/${id}`, isPdf: /\.pdf$/i.test(stored), chapter: group.number });
});

// Student ID photos are private: only the coordinator and the student who owns the photo can open one.
router.get('/id-photo/:id', requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role !== 'admin' && req.user.id !== id) {
    return res.status(403).render('error', { title: 'No access', message: 'You cannot open this photo.' });
  }
  // A coordinator can open only the photos of students in their own workspace.
  const u = await db.get('SELECT id_photo FROM users WHERE id = ? AND workspace_id = ?', [id, req.user.workspace_id]);
  if (!u || !u.id_photo || !fs.existsSync(path.join(db.UPLOAD_DIR, path.basename(u.id_photo)))) {
    return res.status(404).render('error', { title: 'No photo', message: 'No ID photo is on file for this account.' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.basename(u.id_photo), { root: db.UPLOAD_DIR });
});

// ---------- profile picture, for students, advisers and coordinators: JPG, PNG or WEBP up to 3 MB ----------
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: db.UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, 'avatar-' + crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('WRONG_TYPE')),
});
const removeStored = (name) => name && fs.rmSync(path.join(db.UPLOAD_DIR, path.basename(name)), { force: true });
const me = (req) => db.get('SELECT id, name, email, role, student_no, course, year_level, section, avatar FROM users WHERE id = ?', [req.user.id]);

router.get('/profile', requireLogin, async (req, res) => res.render('profile', { title: 'My profile', me: await me(req) }));

router.post(
  '/profile/avatar',
  requireLogin,
  (req, res, next) =>
    avatarUpload.single('avatar')(req, res, (err) => {
      if (!err) return next();
      req.flash('error', err.message === 'WRONG_TYPE' ? 'Use a JPG, PNG or WEBP photo.' : err.code === 'LIMIT_FILE_SIZE' ? 'The photo is larger than 3 MB.' : 'The upload failed. Try again.');
      res.redirect('/profile');
    }),
  csrfCheck,
  async (req, res) => {
    if (!req.file) { req.flash('error', 'Choose a photo first.'); return res.redirect('/profile'); }
    if (!looksLikeImage(req.file)) {
      fs.rmSync(req.file.path, { force: true });
      req.flash('error', 'That file is not a valid image. Use a JPG, PNG or WEBP photo.');
      return res.redirect('/profile');
    }
    const old = (await me(req)).avatar;
    await db.run('UPDATE users SET avatar = ? WHERE id = ?', [req.file.filename, req.user.id]);
    removeStored(old); // a replaced photo does not stay on the disk
    await L.log(req.user.id, old ? 'replaced their profile photo' : 'added a profile photo');
    req.flash('ok', old ? 'Your profile photo was replaced.' : 'Your profile photo was saved.');
    res.redirect('/profile');
  }
);

router.post('/profile/class', requireLogin, async (req, res) => {
  if (req.user.role !== 'student') return res.redirect('/profile');
  const cls = L.readClass(req.body);
  if (cls.error) req.flash('error', cls.error);
  else {
    await db.run('UPDATE users SET course = ?, year_level = ?, section = ? WHERE id = ?', [cls.value.course, cls.value.year_level, cls.value.section, req.user.id]);
    await L.log(req.user.id, 'updated their course, year level and section');
    req.flash('ok', 'Your course, year level and section were saved.');
  }
  res.redirect('/profile');
});

router.post('/profile/avatar/delete', requireLogin, async (req, res) => {
  const old = (await me(req)).avatar;
  if (old) {
    await db.run('UPDATE users SET avatar = NULL WHERE id = ?', [req.user.id]);
    removeStored(old);
    await L.log(req.user.id, 'removed their profile photo');
    req.flash('ok', 'Your profile photo was removed.');
  }
  res.redirect('/profile');
});

// Who sees whose photo, always inside one workspace:
//  - coordinators and advisers are visible to everybody in the workspace, so students know who runs and advises them;
//  - a student is visible to their group mates, to their own adviser and to the coordinator, not to other students.
router.get('/avatar/:id', requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  // The system administrator has no workspace, so their own photo is matched by id alone.
  const u = req.user.role === 'superadmin'
    ? await db.get('SELECT avatar, role FROM users WHERE id = ?', [id])
    : await db.get('SELECT avatar, role FROM users WHERE id = ? AND (workspace_id = ? OR (id = ? AND role = ?))', [id, req.user.workspace_id, id, 'superadmin']);
  if (!u || !u.avatar) return res.status(404).type('text').send('No photo');
  let ok = req.user.id === id || req.user.role === 'admin' || req.user.role === 'superadmin' || u.role === 'admin' || u.role === 'adviser';
  if (!ok && req.user.role === 'student') {
    ok = !!(await db.get('SELECT 1 FROM group_members a JOIN group_members b ON a.group_id = b.group_id WHERE a.student_id = ? AND b.student_id = ?', [req.user.id, id]));
  }
  if (!ok && req.user.role === 'adviser') {
    ok = !!(await db.get('SELECT 1 FROM group_members m JOIN thesis_groups g ON g.id = m.group_id WHERE m.student_id = ? AND g.adviser_id = ?', [id, req.user.id]));
  }
  const file = ok ? path.join(db.UPLOAD_DIR, path.basename(u.avatar)) : null;
  if (!file || !fs.existsSync(file)) return res.status(404).type('text').send('No photo');
  res.set('Cache-Control', 'private, max-age=3600'); // the page adds ?v=<file name>, so a new photo has a new address
  res.sendFile(path.basename(u.avatar), { root: db.UPLOAD_DIR });
});

const NOTIF_SOURCES = ['adviser', 'coordinator', 'student', 'panel', 'system'];

// Nothing is marked read just by opening the page: a group of notifications is marked read when the person opens it.
router.get('/notifications', requireLogin, async (req, res) => {
  const items = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
  // Announcement notifications saved before they had their own page point to "/". Find the announcement by its title.
  const PREFIX = 'New announcement: ';
  for (const n of items) {
    if (n.link !== '/' || !String(n.message).startsWith(PREFIX)) continue;
    const a = await db.get('SELECT id FROM announcements WHERE title = ? AND workspace_id = ? ORDER BY id DESC LIMIT 1', [n.message.slice(PREFIX.length), req.user.workspace_id || 0]);
    if (a) n.link = `/announcements/${a.id}`;
  }
  await addClassLabels(items, req.user);
  res.render('notifications', { title: 'Notifications', items });
});

// Puts "IT · 4th year · 4B" on each notification (n.cls) so people can tell sections apart. A notification does not store its group,
// so it is found from the link (group page or message thread), then from the student's own group, then from a group name in the text.
async function addClassLabels(items, user) {
  const wid = user.workspace_id;
  if (!wid) return;
  const groups = await db.all('SELECT id, name, course, year_level, section, adviser_id FROM thesis_groups WHERE workspace_id = ?', [wid]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const named = groups.filter((g) => g.name.length >= 3 && L.classLabel(g)).sort((a, b) => b.name.length - a.name.length);
  const own = user.role === 'student' ? await L.groupOfStudent(user.id) : null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const n of items) {
    const link = String(n.link || '');
    let label = '';
    let m;
    if ((m = link.match(/^\/(?:adviser\/group|panel\/group|admin\/groups|admin\/grades)\/(\d+)/))) label = L.classLabel(byId.get(Number(m[1])) || {});
    else if ((m = link.match(/^\/messages\/(\d+)/))) {
      const c = await M.openFor(user, m[1]);
      if (c) label = M.classOf(c);
    } else if (own && link.startsWith('/student')) label = L.classLabel(own);
    if (!label) {
      const g = named.find((x) => new RegExp(`(^|[^\\w])${esc(x.name)}([^\\w]|$)`, 'i').test(String(n.message)));
      if (g) label = L.classLabel(g);
    }
    n.cls = label;
  }
}

router.post('/notifications/read', requireLogin, async (req, res) => {
  const source = String(req.body.source || '');
  if (!NOTIF_SOURCES.includes(source)) return res.status(400).json({ error: 'Unknown group.' });
  // "system" also holds any older notification whose source is not one of the named groups.
  if (source === 'system') await db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND (source = 'system' OR source NOT IN ('adviser','coordinator','student','panel'))`, [req.user.id]);
  else await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND source = ?', [req.user.id, source]);
  res.json({ unread: (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id])).n });
});

// ---------- account: change your own password ----------
router.get('/account', requireLogin, (req, res) => res.render('account', { title: 'My account' }));

// A coordinator can correct their own name. Students and advisers keep the name on their record.
router.post('/account/name', requireLogin, async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).render('error', { title: 'No access', message: 'Only the coordinator can change their name here.' });
  }
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 255);
  if (!name) { req.flash('error', 'Enter your name.'); return res.redirect('/account'); }
  if (name === req.user.name) { req.flash('ok', 'Your name is already saved.'); return res.redirect('/account'); }
  await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
  await L.log(req.user.id, `changed their name from ${req.user.name} to ${name}`);
  req.flash('ok', 'Your name was saved.');
  res.redirect('/account');
});

// Changing the password takes two steps: the current and new password are checked, then a 6-digit code emailed to
// the account must be entered. Only then is the password replaced.
const PW_MINUTES = 15;
const PW_TRIES = 5;
const PW_RESEND_SECONDS = 60;
const pwCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const sendPwCode = (user, code) =>
  mailer.send({
    to: user.email,
    subject: 'Your ThesisTrack password change code',
    text: `Hello ${user.name},\n\nSomeone asked to change the password of your ThesisTrack account. Your confirmation code: ${code}\nIt works for ${PW_MINUTES} minutes.\n\nIf this was not you, ignore this email. Your password stays the same without the code.\n`,
  });
const verifyPage = (res, extra = {}) =>
  res.status(extra.error ? 400 : 200).render('account-verify', { title: 'Confirm password change', minutes: PW_MINUTES, ...extra });

router.post('/account/password', requireLogin, async (req, res) => {
  const { current = '', password = '', confirm = '' } = req.body;
  const back = (msg) => res.status(400).render('account', { title: 'My account', error: msg });
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!row || !await bcrypt.compare(String(current), row.password_hash)) return back('Your current password is not correct.');
  if (String(password).length < 8) return back('Use a new password with at least 8 characters.');
  if (weakPassword(password, req.user.email)) return back(weakPassword(password, req.user.email));
  if (password !== confirm) return back('The two new passwords do not match.');
  if (password === current) return back('Choose a password that is different from the current one.');
  const code = pwCode();
  const newHash = await bcrypt.hash(String(password), 10);
  const codeHash = await bcrypt.hash(code, 10);
  await db.run('DELETE FROM password_changes WHERE user_id = ?', [req.user.id]);
  await db.run(`INSERT INTO password_changes (user_id, new_hash, code_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ${PW_MINUTES} MINUTE))`, [req.user.id, newHash, codeHash]);
  try { await sendPwCode(req.user, code); } catch (e) { console.error(e); }
  req.flash('ok', mailer.configured() ? `We sent a 6-digit code to ${req.user.email}.` : 'Email is not set up, so the code is in outbox/mail.log.');
  res.redirect('/account/password/verify');
});

router.get('/account/password/verify', requireLogin, async (req, res) => {
  if (!(await db.get('SELECT 1 FROM password_changes WHERE user_id = ? AND expires_at > NOW()', [req.user.id]))) {
    req.flash('error', 'No password change is waiting, or it expired. Start again.');
    return res.redirect('/account');
  }
  verifyPage(res);
});

router.post('/account/password/verify', requireLogin, async (req, res) => {
  const p = await db.get('SELECT * FROM password_changes WHERE user_id = ? AND expires_at > NOW()', [req.user.id]);
  if (!p) { req.flash('error', 'No password change is waiting, or it expired. Start again.'); return res.redirect('/account'); }
  if (p.attempts >= PW_TRIES) return verifyPage(res, { error: 'Too many wrong codes. Request a new code.' });
  const code = String(req.body.code || '').trim();
  if (!/^\d{6}$/.test(code) || !await bcrypt.compare(code, p.code_hash)) {
    await db.run('UPDATE password_changes SET attempts = attempts + 1 WHERE id = ?', [p.id]);
    return verifyPage(res, { error: 'That code is not right, or it has expired. Check the email and try again, or request a new code.' });
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [p.new_hash, req.user.id]);
  await db.run('DELETE FROM password_changes WHERE id = ?', [p.id]);
  await endSessions(req.user.id, req.sessionID); // other devices are signed out, this one stays
  await L.log(req.user.id, 'changed their password (confirmed with an emailed code)');
  req.flash('ok', 'Your password was changed.');
  res.redirect('/account');
});

router.post('/account/password/resend', requireLogin, async (req, res) => {
  const p = await db.get('SELECT * FROM password_changes WHERE user_id = ? AND expires_at > NOW()', [req.user.id]);
  const to = (type, msg) => { req.flash(type, msg); res.redirect(p ? '/account/password/verify' : '/account'); };
  if (!p) return to('error', 'No password change is waiting, or it expired. Start again.');
  if (Date.now() - new Date(p.sent_at).getTime() < PW_RESEND_SECONDS * 1000) return to('error', `Wait ${PW_RESEND_SECONDS} seconds before asking for another code.`);
  const code = pwCode();
  await db.run(`UPDATE password_changes SET code_hash = ?, attempts = 0, sent_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ${PW_MINUTES} MINUTE) WHERE id = ?`, [await bcrypt.hash(code, 10), p.id]);
  try { await sendPwCode(req.user, code); } catch (e) { console.error(e); }
  to('ok', mailer.configured() ? `A new code was sent to ${req.user.email}.` : 'Email is not set up, so the new code is in outbox/mail.log.');
});

module.exports = router;
