// Checks messaging: who can open which thread, privacy between groups and workspaces, hiding, limits and unread counts.
// Use a fresh database: `npm run seed`, then `npm start` in one terminal and `node scripts/messages-test.js` in another.
// Set BASE if the server is not on http://localhost:3000, and keep DB_NAME the same as the server's.
require('../loadenv');
const db = require('../db');
const BASE = process.env.BASE || 'http://localhost:3000';
let failed = 0;
const check = (cond, msg) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) failed++;
};

class Client {
  constructor() { this.cookies = {}; }
  async req(path, opts = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie } });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return res;
  }
  async page(path) {
    const r = await this.req(path);
    return { status: r.status, body: await r.text(), loc: r.headers.get('location') };
  }
  async token(path) {
    return /name="_csrf" value="([^"]+)"/.exec((await this.page(path)).body)?.[1];
  }
  async post(path, fields, tokenPage) {
    const body = new URLSearchParams({ _csrf: await this.token(tokenPage), ...fields });
    const r = await this.req(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return { status: r.status, loc: r.headers.get('location'), body: r.status >= 300 && r.status < 400 ? '' : await r.text() };
  }
  async login(email, role) {
    return role === 'superadmin'
      ? this.post('/system/login', { email, password: 'password123' }, '/system/login')
      : this.post('/login', { email, password: 'password123', role }, '/login');
  }
}

const who = async (email, role) => { const c = new Client(); await c.login(email, role); return c; };
// The id of the thread whose title is shown on the user's Messages page.
const threadId = async (client, title) => new RegExp(`href="/messages/([0-9]+)">\\s*<span class="row"><b>${title}</b>`).exec((await client.page('/messages')).body)?.[1];
const send = (client, id, body) => client.post(`/messages/${id}/send`, { body }, `/messages/${id}`);
const badge = async (client) => /Messages <span class="badge">(\d+)<\/span>/.exec((await client.page('/messages/0')).body)?.[1] || '0';

(async () => {
  await db.init();
  const juan = await who('juan@student.edu.ph', 'student');
  const maria = await who('maria@student.edu.ph', 'student');
  const diego = await who('diego@student.edu.ph', 'student');
  const rico = await who('rico@student.edu.ph', 'student');
  const reyes = await who('reyes@school.edu.ph', 'adviser');
  const coord = await who('admin@school.edu.ph', 'admin');
  const other = await who('admin2@school.edu.ph', 'admin');
  const sys = await who('system@school.edu.ph', 'superadmin');

  // Who sees what
  let p = await juan.page('/messages');
  check(p.status === 200 && p.body.includes('Team Pagasa') && p.body.includes('Coordinator'), 'a student sees their group thread and the coordinator thread');
  p = await rico.page('/messages');
  check(p.body.includes('Coordinator') && !p.body.includes('Team Pagasa'), 'a student with no group sees only the coordinator thread');
  const wide = await reyes.page('/messages');
  check(['Team Pagasa', 'Team Lakbay', 'Team Aklat'].every((g) => wide.body.includes(g)), 'an adviser sees one thread for every group they advise');
  check((await sys.page('/messages')).status === 403, 'the system administrator cannot open messages');
  check((await new Client().page('/messages')).loc === '/login', 'a visitor is sent to the login page');

  // Group thread
  const gid = await threadId(juan, 'Team Pagasa');
  check(!!gid, 'the group thread has a page');
  const before = await badge(maria);
  await send(juan, gid, 'Good morning, we uploaded Chapter 2 <b>today</b>.');
  check((await juan.page(`/messages/${gid}`)).body.includes('Good morning, we uploaded Chapter 2 &lt;b&gt;today&lt;/b&gt;.'), 'the sender sees the message, with markup shown as plain text');
  check(Number(await badge(maria)) === Number(before) + 1, 'a group mate gets an unread count in the menu');
  check((await maria.page(`/messages/${gid}`)).body.includes('Good morning, we uploaded'), 'a group mate reads it');
  check(Number(await badge(maria)) === Number(before), 'opening the thread clears the unread count');
  check((await reyes.page(`/messages/${gid}`)).body.includes('Good morning, we uploaded'), 'the adviser reads it');
  check((await coord.page(`/messages/${gid}`)).body.includes('Good morning, we uploaded'), 'the coordinator reads it');
  check((await diego.page(`/messages/${gid}`)).status === 404, 'a student of another group cannot open it');
  check((await other.page(`/messages/${gid}`)).status === 404, 'a coordinator of another workspace cannot open it');
  check((await rico.page(`/messages/${gid}`)).status === 404, 'a student with no group cannot open it');
  check((await sys.page(`/messages/${gid}`)).status === 403, 'the system administrator cannot open a thread');
  check((await diego.post(`/messages/${gid}/send`, { body: 'sneaky' }, '/messages')).status === 404, 'an outsider cannot post into it');

  // Private thread with the coordinator
  const jc = await threadId(juan, 'Coordinator');
  await send(juan, jc, 'Sir, we have a problem with our adviser schedule.');
  check((await maria.page(`/messages/${jc}`)).status === 404, 'a group mate cannot read a private thread');
  check((await reyes.page(`/messages/${jc}`)).status === 404, 'the adviser cannot read a student’s private thread');
  check((await coord.page(`/messages/${jc}`)).body.includes('problem with our adviser schedule'), 'the coordinator reads the private thread');
  check((await other.page(`/messages/${jc}`)).status === 404, 'another workspace’s coordinator cannot');
  await send(coord, jc, 'Thanks, I will talk to Dr. Reyes.');
  check((await juan.page(`/messages/${jc}`)).body.includes('I will talk to Dr. Reyes'), 'the student reads the coordinator’s reply');

  // Notifications are grouped: two messages, one unread notification
  const mariaN = await db.get('SELECT id FROM users WHERE email = ?', ['paolo@student.edu.ph']);
  await send(juan, gid, 'Second message');
  await send(juan, gid, 'Third message');
  const n = await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0 AND link = ?', [mariaN.id, `/messages/${gid}`]);
  check(n.n === 1, 'several messages in a row make one notification, not one each');

  // Coordinator starts a thread
  const lakbay = (await db.get("SELECT id FROM thesis_groups WHERE name = 'Team Lakbay'")).id;
  let r = await coord.post('/messages/start', { target: `group:${lakbay}` }, '/messages');
  check(/^\/messages\/\d+$/.test(r.loc || ''), 'the coordinator starts a thread with a group');
  await send(coord, r.loc.split('/').pop(), 'Reminder: Chapter 3 is overdue.');
  check((await diego.page('/messages')).body.includes('Reminder: Chapter 3 is overdue.'), 'the group sees the coordinator’s message');
  const carlaId = (await db.get("SELECT id FROM users WHERE email = 'carla@student.edu.ph'")).id;
  r = await coord.post('/messages/start', { target: `user:${carlaId}` }, '/messages');
  check(/^\/messages\/\d+$/.test(r.loc || ''), 'the coordinator starts a private thread with a student');
  const otherStudent = (await db.get("SELECT id FROM users WHERE workspace_id != (SELECT workspace_id FROM users WHERE email = 'admin@school.edu.ph') AND role = 'adviser' LIMIT 1"));
  if (otherStudent) {
    r = await coord.post('/messages/start', { target: `user:${otherStudent.id}` }, '/messages');
    check(r.loc === '/messages', 'the coordinator cannot start a thread with someone from another workspace');
  }
  check((await juan.post('/messages/start', { target: `group:${lakbay}` }, '/messages')).status === 403, 'a student cannot start threads');

  // Limits and moderation
  await send(juan, gid, '   ');
  await send(juan, gid, 'x'.repeat(2001));
  const count = (await db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [gid])).n;
  check(count === 3, 'empty and over-long messages are refused');
  const bad = (await db.get('SELECT id FROM messages WHERE conversation_id = ? AND body = ?', [gid, 'Second message'])).id;
  await coord.post(`/messages/${gid}/hide/${bad}`, {}, `/messages/${gid}`);
  const seen = (await maria.page(`/messages/${gid}`)).body;
  check(!seen.includes('Second message') && seen.includes('This message was hidden by the coordinator.'), 'a hidden message is replaced by a notice for students');
  check((await coord.page(`/messages/${gid}`)).body.includes('Second message'), 'the coordinator still sees the hidden text');
  check((await maria.post(`/messages/${gid}/hide/${bad}`, {}, `/messages/${gid}`)).status === 403, 'a student cannot hide messages');
  const poll = await (await maria.req(`/messages/${gid}/poll?after=0`)).json();
  check(Array.isArray(poll.items) && poll.items.length >= 3 && !JSON.stringify(poll).includes('Second message'), 'the live update also hides the text');
  let flood = 0;
  for (let i = 0; i < 22; i++) { await send(juan, gid, `flood ${i}`); }
  flood = (await db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND body LIKE ?', [gid, 'flood %'])).n;
  check(flood <= 20, 'more than 20 messages a minute are refused');

  // Removing a person who has a private thread works
  await rico.page('/messages');
  const ricoId = (await db.get("SELECT id FROM users WHERE email = 'rico@student.edu.ph'")).id;
  await coord.post('/admin/users/bulk', { action: 'remove', ids: [String(ricoId)] }, '/admin/users');
  check(!(await db.get('SELECT 1 FROM users WHERE id = ?', [ricoId])) && !(await db.get('SELECT 1 FROM conversations WHERE user_id = ?', [ricoId])), 'removing a person also removes their private thread');

  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll messaging checks passed.');
  process.exit(failed ? 1 : 0);
})();
