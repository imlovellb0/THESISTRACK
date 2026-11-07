const router = require('express').Router();
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { csrfCheck } = require('../middleware');
const L = require('../lib');
const M = require('../messaging');

// ---------- attachments: PDF, Word or an image, up to 10 MB, saved under a random name ----------
const ALLOWED = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg'];
const upload = multer({
  storage: multer.diskStorage({
    destination: db.UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (ALLOWED.includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('WRONG_TYPE'))),
});
const removeFile = (file) => file && fs.rmSync(file.path, { force: true });

// Checks the first bytes, so a renamed .exe or .html is not accepted as a document or an image.
function looksRight(file) {
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') return head.subarray(0, 4).toString('latin1') === '%PDF';
  if (ext === '.docx') return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (ext === '.png') return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (ext === '.jpg' || ext === '.jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  return head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])); // .doc
}

const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That conversation does not exist, or you are not part of it.' });

// What the page and the live update show for one message. The coordinator sees hidden text; everybody else sees a notice.
const shape = (m, user) => ({
  id: m.id,
  mine: m.sender_id === user.id,
  sender: m.sender_name || 'Removed user',
  role: m.sender_role ? [L.ROLE_LABEL[m.sender_role], m.sender_role === 'student' ? L.classLabel(m) : ''].filter(Boolean).join(' · ') : '', // a student's class follows the role
  body: m.hidden && user.role !== 'admin' ? 'This message was hidden by the coordinator.' : m.body,
  hidden: !!m.hidden,
  file: m.file_name && !(m.hidden && user.role !== 'admin') ? m.file_name : null, // a hidden message also hides its file
  when: L.fmtDateTime(m.created_at),
});

async function page(req, res, current) {
  const threads = await M.listFor(req.user);
  const view = { title: 'Messages', threads, current: null, items: [], members: [], titleOf: (c) => M.titleOf(c, req.user), classOf: M.classOf, MAX: M.MAX_LENGTH, starters: null };
  if (current) {
    const rows = await M.messagesOf(current);
    await M.markRead(current, req.user);
    view.current = current;
    view.members = current.kind === 'group' ? await L.membersOf(current.group_id) : [];
    view.items = rows.map((m) => shape(m, req.user));
    view.lastId = rows.length ? rows[rows.length - 1].id : 0;
    view.threads = threads.map((t) => (t.id === current.id ? { ...t, unread: 0 } : t));
  }
  if (req.user.role === 'admin') {
    const wid = req.user.workspace_id;
    view.starters = {
      groups: await db.all('SELECT id, name, course, year_level, section FROM thesis_groups WHERE workspace_id = ? ORDER BY name', [wid]),
      people: await db.all("SELECT id, name, role, course, year_level, section FROM users WHERE workspace_id = ? AND active = 1 AND role IN ('student','adviser') ORDER BY role, name", [wid]),
    };
  }
  res.locals.unreadMsgs = await M.unreadCount(req.user);
  res.render('messages', view);
}

router.get('/', (req, res) => page(req, res, null));

// The coordinator starts (or reopens) a thread with a group or with one person.
router.post('/start', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'No access', message: 'Only the coordinator starts new conversations.' });
  const [kind, rawId] = String(req.body.target || '').split(':');
  const id = Number(rawId);
  const wid = req.user.workspace_id;
  let thread = null;
  if (kind === 'group') {
    const g = await db.get('SELECT * FROM thesis_groups WHERE id = ? AND workspace_id = ?', [id, wid]);
    if (g) thread = await M.ensureGroupThread(g);
  } else if (kind === 'user') {
    const u = await db.get("SELECT id FROM users WHERE id = ? AND workspace_id = ? AND active = 1 AND role IN ('student','adviser')", [id, wid]);
    if (u) thread = await M.ensureDirectThread(wid, u.id);
  }
  if (!thread) { req.flash('error', 'Choose a group or a person from the list.'); return res.redirect('/messages'); }
  res.redirect(`/messages/${thread.id}`);
});

router.get('/:id', async (req, res) => {
  const c = await M.openFor(req.user, req.params.id);
  if (!c) return notFound(res);
  return page(req, res, c);
});

router.post('/:id/send',
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    req.flash('error', err.message === 'WRONG_TYPE' ? 'Attach a PDF, Word file, PNG or JPG.' : err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB.' : 'The upload failed. Try again.');
    res.redirect(`/messages/${Number(req.params.id) || ''}`);
  }),
  csrfCheck,
  async (req, res) => {
    const c = await M.openFor(req.user, req.params.id);
    if (!c) { removeFile(req.file); return notFound(res); }
    const body = String(req.body.body || '').replace(/\r\n/g, '\n').trim();
    const fail = (msg) => { removeFile(req.file); req.flash('error', msg); res.redirect(`/messages/${c.id}`); };
    if (!body && !req.file) return fail('Write a message or attach a file first.');
    if (body.length > M.MAX_LENGTH) return fail(`A message can have up to ${M.MAX_LENGTH} characters.`);
    if (req.file && !looksRight(req.file)) return fail('That file does not look like a real PDF, Word file, PNG or JPG. Check the file and try again.');
    if (await M.tooFast(req.user)) return fail('You are sending messages too fast. Wait a minute and try again.');
    await M.send(c, req.user, body, req.file);
    res.redirect(`/messages/${c.id}`);
  });

// Download an attachment. Only people who can open the thread get it, and a hidden message's file is for the coordinator only.
router.get('/:id/file/:mid', async (req, res) => {
  const c = await M.openFor(req.user, req.params.id);
  if (!c) return notFound(res);
  const m = await db.get('SELECT file_name, file_stored, hidden FROM messages WHERE id = ? AND conversation_id = ? AND file_stored IS NOT NULL', [Number(req.params.mid), c.id]);
  if (!m || (m.hidden && req.user.role !== 'admin')) return notFound(res);
  const file = path.join(db.UPLOAD_DIR, path.basename(m.file_stored));
  if (!fs.existsSync(file)) return res.status(404).render('error', { title: 'File missing', message: 'The file is no longer on the server.' });
  res.download(file, m.file_name); // always a download, never shown inside the page
});

// The page asks this every few seconds for messages newer than the last one it shows.
router.get('/:id/poll', async (req, res) => {
  const c = await M.openFor(req.user, req.params.id);
  if (!c) return res.status(404).json({ items: [] });
  const rows = await M.messagesOf(c, { after: Number(req.query.after) || 0 });
  if (rows.length) await M.markRead(c, req.user);
  res.set('Cache-Control', 'no-store').json({ items: rows.map((m) => shape(m, req.user)) });
});

// The coordinator hides an abusive message, or shows it again. The text stays in the database as evidence.
router.post('/:id/hide/:mid', async (req, res) => {
  const c = await M.openFor(req.user, req.params.id);
  if (!c) return notFound(res);
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'No access', message: 'Only the coordinator can hide a message.' });
  const m = await db.get('SELECT id, hidden FROM messages WHERE id = ? AND conversation_id = ?', [Number(req.params.mid), c.id]);
  if (m) {
    await db.run('UPDATE messages SET hidden = ? WHERE id = ?', [m.hidden ? 0 : 1, m.id]);
    await L.log(req.user.id, `${m.hidden ? 'showed' : 'hid'} a message in ${M.titleOf(c, req.user)}`);
  }
  res.redirect(`/messages/${c.id}`);
});

module.exports = router;
