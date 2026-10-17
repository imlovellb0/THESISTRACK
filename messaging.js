// Messages between students, advisers and the coordinator, all inside one workspace.
//  - A group thread: the group's students, its adviser and the coordinator.
//  - A direct thread: one student or adviser with the coordinator. Every coordinator of the workspace can answer it.
// The system administrator is never a participant, so message text stays private to the workspace.
const db = require('./db');
const L = require('./lib');

const MAX_LENGTH = 2000;

// The SQL condition (on conversations c) that says which threads a user may open.
function visible(user) {
  if (user.role === 'student') {
    return { sql: "((c.kind = 'group' AND c.group_id IN (SELECT group_id FROM group_members WHERE student_id = ?)) OR (c.kind = 'direct' AND c.user_id = ?))", args: [user.id, user.id] };
  }
  if (user.role === 'adviser') {
    return { sql: "((c.kind = 'group' AND c.group_id IN (SELECT id FROM thesis_groups WHERE adviser_id = ?)) OR (c.kind = 'direct' AND c.user_id = ?))", args: [user.id, user.id] };
  }
  if (user.role === 'admin') return { sql: 'c.workspace_id = ?', args: [user.workspace_id] };
  return { sql: '1 = 0', args: [] };
}

const unreadSql = 'EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.hidden = 0 AND (m.sender_id IS NULL OR m.sender_id != ?) AND m.id > COALESCE((SELECT r.last_read FROM conversation_reads r WHERE r.conversation_id = c.id AND r.user_id = ?), 0))';

// How many threads have something the user has not read.
async function unreadCount(user) {
  const v = visible(user);
  return (await db.get(`SELECT COUNT(*) AS n FROM conversations c WHERE ${v.sql} AND ${unreadSql}`, [...v.args, user.id, user.id])).n;
}

async function ensureGroupThread(group) {
  await db.run("INSERT IGNORE INTO conversations (workspace_id, kind, group_id) VALUES (?, 'group', ?)", [group.workspace_id, group.id]);
  return (await db.get('SELECT * FROM conversations WHERE group_id = ?', [group.id]));
}
async function ensureDirectThread(workspaceId, userId) {
  await db.run("INSERT IGNORE INTO conversations (workspace_id, kind, user_id) VALUES (?, 'direct', ?)", [workspaceId, userId]);
  return (await db.get('SELECT * FROM conversations WHERE user_id = ?', [userId]));
}

// The threads a person sees, newest activity first. Students and advisers always get their own threads created for them.
async function listFor(user) {
  if (user.role === 'student') {
    const g = await L.groupOfStudent(user.id);
    if (g) await ensureGroupThread(g);
    await ensureDirectThread(user.workspace_id, user.id);
  } else if (user.role === 'adviser') {
    for (const g of await db.all('SELECT * FROM thesis_groups WHERE adviser_id = ?', [user.id])) await ensureGroupThread(g);
    await ensureDirectThread(user.workspace_id, user.id);
  }
  const v = visible(user);
  return db.all(
    `SELECT c.*, g.name AS group_name, u.name AS user_name, u.role AS user_role,
       (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.hidden = 0 ORDER BY m.id DESC LIMIT 1) AS last_body,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS total,
       ${unreadSql} AS unread
     FROM conversations c LEFT JOIN thesis_groups g ON g.id = c.group_id LEFT JOIN users u ON u.id = c.user_id
     WHERE ${v.sql} AND (c.kind = 'group' OR u.active = 1)
     ORDER BY COALESCE(c.last_at, c.created_at) DESC, c.id DESC`,
    [user.id, user.id, ...v.args]
  );
}

// One thread if the user may open it, otherwise undefined.
async function openFor(user, id) {
  const v = visible(user);
  return db.get(
    `SELECT c.*, g.name AS group_name, g.adviser_id AS group_adviser, u.name AS user_name, u.role AS user_role
     FROM conversations c LEFT JOIN thesis_groups g ON g.id = c.group_id LEFT JOIN users u ON u.id = c.user_id
     WHERE c.id = ? AND ${v.sql}`,
    [Number(id), ...v.args]
  );
}

const titleOf = (c, user) => (c.kind === 'group' ? c.group_name : user.role === 'admin' ? `${c.user_name} (${L.ROLE_LABEL[c.user_role].toLowerCase()})` : 'Coordinator');

async function messagesOf(c, { after = 0, limit = 100 } = {}) {
  const rows = await db.all(
    `SELECT m.id, m.body, m.hidden, m.created_at, m.sender_id, u.name AS sender_name, u.role AS sender_role
     FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ? AND m.id > ?
     ORDER BY m.id DESC LIMIT ${Number(limit)}`,
    [c.id, Number(after)]
  );
  return rows.reverse();
}

async function markRead(c, user) {
  const last = (await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?', [c.id])).id;
  await db.run('INSERT INTO conversation_reads (conversation_id, user_id, last_read) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_read = GREATEST(last_read, VALUES(last_read))', [c.id, user.id, last]);
}

// Everyone who should hear about a new message in this thread.
async function participants(c) {
  const ids = new Set((await db.all("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND workspace_id = ?", [c.workspace_id])).map((r) => r.id));
  if (c.kind === 'direct') ids.add(c.user_id);
  else {
    for (const m of await L.membersOf(c.group_id)) ids.add(m.id);
    if (c.group_adviser) ids.add(c.group_adviser);
  }
  return [...ids];
}

// Saves a message and tells the others once per thread, not once per message.
async function send(c, sender, body) {
  const r = await db.run('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)', [c.id, sender.id, body]);
  await db.run('UPDATE conversations SET last_at = NOW() WHERE id = ?', [c.id]);
  await markRead(c, sender);
  const link = `/messages/${c.id}`;
  const where = c.kind === 'group' ? c.group_name : sender.role === 'admin' ? 'a private message' : `${sender.name}’s private thread`;
  for (const id of await participants(c)) {
    if (id === sender.id) continue;
    if (await db.get('SELECT 1 FROM notifications WHERE user_id = ? AND link = ? AND is_read = 0', [id, link])) continue;
    await L.notify(id, `New message from ${sender.name} (${where}).`, link, sender.role === 'admin' ? 'coordinator' : sender.role);
  }
  return r.lastInsertRowid;
}

// More than 20 messages in a minute is a flood, not a conversation.
const tooFast = async (user) => (await db.get('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE)', [user.id])).n >= 20;

module.exports = { MAX_LENGTH, visible, unreadCount, listFor, openFor, titleOf, messagesOf, markRead, send, tooFast, ensureGroupThread, ensureDirectThread };
