// Pages every signed-in role uses: file downloads, notifications and the account (change password) page.
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const db = require('../db');
const L = require('../lib');
const { requireLogin, csrfCheck } = require('../middleware');
const { looksLikeImage } = require('../imagecheck');

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
  res.download(file, sub.original_name);
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
const me = (req) => db.get('SELECT id, name, email, role, student_no, avatar FROM users WHERE id = ?', [req.user.id]);

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

router.get('/notifications', requireLogin, async (req, res) => {
  const items = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
  await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
  const wasUnread = res.locals.unread;
  res.locals.unread = 0;
  res.render('notifications', { title: 'Notifications', items, wasUnread });
});

router.post('/notifications/clear', requireLogin, async (req, res) => {
  await db.run('DELETE FROM notifications WHERE user_id = ?', [req.user.id]);
  req.flash('ok', 'Notifications cleared.');
  res.redirect('/notifications');
});

router.post('/notifications/:id/delete', requireLogin, async (req, res) => {
  await db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  res.redirect('/notifications');
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

router.post('/account/password', requireLogin, async (req, res) => {
  const { current = '', password = '', confirm = '' } = req.body;
  const back = (msg) => res.status(400).render('account', { title: 'My account', error: msg });
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!row || !await bcrypt.compare(String(current), row.password_hash)) return back('Your current password is not correct.');
  if (String(password).length < 8) return back('Use a new password with at least 8 characters.');
  if (password !== confirm) return back('The two new passwords do not match.');
  if (password === current) return back('Choose a password that is different from the current one.');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(String(password), 10), req.user.id]);
  await L.log(req.user.id, 'changed their password');
  req.flash('ok', 'Your password was changed.');
  res.redirect('/account');
});

module.exports = router;
