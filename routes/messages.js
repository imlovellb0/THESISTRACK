const router = require('express').Router();
const db = require('../db');
const L = require('../lib');
const M = require('../messaging');

const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That conversation does not exist, or you are not part of it.' });

// What the page and the live update show for one message. The coordinator sees hidden text; everybody else sees a notice.
const shape = (m, user) => ({
  id: m.id,
  mine: m.sender_id === user.id,
  sender: m.sender_name || 'Removed user',
  role: m.sender_role ? L.ROLE_LABEL[m.sender_role] : '',
  body: m.hidden && user.role !== 'admin' ? 'This message was hidden by the coordinator.' : m.body,
  hidden: !!m.hidden,
  when: L.fmtDateTime(m.created_at),
});

async function page(req, res, current) {
  const threads = await M.listFor(req.user);
  const view = { title: 'Messages', threads, current: null, items: [], titleOf: (c) => M.titleOf(c, req.user), MAX: M.MAX_LENGTH, starters: null };
  if (current) {
    const rows = await M.messagesOf(current);
    await M.markRead(current, req.user);
    view.current = current;
    view.items = rows.map((m) => shape(m, req.user));
    view.lastId = rows.length ? rows[rows.length - 1].id : 0;
    view.threads = threads.map((t) => (t.id === current.id ? { ...t, unread: 0 } : t));
  }
  if (req.user.role === 'admin') {
    const wid = req.user.workspace_id;
    view.starters = {
      groups: await db.all('SELECT id, name FROM thesis_groups WHERE workspace_id = ? ORDER BY name', [wid]),
      people: await db.all("SELECT id, name, role FROM users WHERE workspace_id = ? AND active = 1 AND role IN ('student','adviser') ORDER BY role, name", [wid]),
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

router.post('/:id/send', async (req, res) => {
  const c = await M.openFor(req.user, req.params.id);
  if (!c) return notFound(res);
  const body = String(req.body.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) req.flash('error', 'Write a message first.');
  else if (body.length > M.MAX_LENGTH) req.flash('error', `A message can have up to ${M.MAX_LENGTH} characters.`);
  else if (await M.tooFast(req.user)) req.flash('error', 'You are sending messages too fast. Wait a minute and try again.');
  else await M.send(c, req.user, body);
  res.redirect(`/messages/${c.id}`);
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
