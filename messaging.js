// Messages between students, advisers and the coordinator, all inside one workspace.
//  - A group thread: the group's students, its adviser and the coordinator.
//  - A direct thread: one student or adviser with the coordinator. Every coordinator of the workspace can answer it.
//  - An adviser thread: one student with the adviser of their group. The coordinator does not see it.
// The system administrator is never a participant, so message text stays private to the workspace.
const db = require('./db');
const L = require('./lib');

const MAX_LENGTH = 2000;

// Conditions on an adviser thread (conversations c): the student's group has this adviser / any adviser, and who that adviser is.
const ADVISED_BY = 'EXISTS (SELECT 1 FROM group_members gm JOIN thesis_groups tg ON tg.id = gm.group_id WHERE gm.student_id = c.student_id AND tg.adviser_id = ?)';
const HAS_ADVISER = 'EXISTS (SELECT 1 FROM group_members gm JOIN thesis_groups tg ON tg.id = gm.group_id WHERE gm.student_id = c.student_id AND tg.adviser_id IS NOT NULL)';
const ADVISER_NAME = '(SELECT a.name FROM group_members gm JOIN thesis_groups tg ON tg.id = gm.group_id JOIN users a ON a.id = tg.adviser_id WHERE gm.student_id = c.student_id LIMIT 1)';

// The SQL condition (on conversations c) that says which threads a user may open.
function visible(user) {
  if (user.role === 'student') {
    return { sql: `((c.kind = 'group' AND c.group_id IN (SELECT group_id FROM group_members WHERE student_id = ?)) OR (c.kind = 'direct' AND c.user_id = ?) OR (c.kind = 'adviser' AND c.student_id = ? AND ${HAS_ADVISER}))`, args: [user.id, user.id, user.id] };
  }
  if (user.role === 'adviser') {
    return { sql: `((c.kind = 'group' AND c.group_id IN (SELECT id FROM thesis_groups WHERE adviser_id = ?)) OR (c.kind = 'direct' AND c.user_id = ?) OR (c.kind = 'adviser' AND ${ADVISED_BY}))`, args: [user.id, user.id, user.id] };
  }
  if (user.role === 'admin') return { sql: "c.workspace_id = ? AND c.kind != 'adviser'", args: [user.workspace_id] };
  return { sql: '1 = 0', args: [] };
}

// Course, year level and section of whoever a thread is about: the group, the student, or the student/adviser the coordinator wrote to.
const CLASS_COLS = 'g.course AS g_course, g.year_level AS g_year, g.section AS g_section, s.course AS s_course, s.year_level AS s_year, s.section AS s_section, u.course AS u_course, u.year_level AS u_year, u.section AS u_section';

const unreadSql ='EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.hidden = 0 AND (m.sender_id IS NULL OR m.sender_id != ?) AND m.id > COALESCE((SELECT r.last_read FROM conversation_reads r WHERE r.conversation_id = c.id AND r.user_id = ?), 0))';

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
async function ensureAdviserThread(workspaceId, studentId) {
  await db.run("INSERT IGNORE INTO conversations (workspace_id, kind, student_id) VALUES (?, 'adviser', ?)", [workspaceId, studentId]);
  return (await db.get('SELECT * FROM conversations WHERE student_id = ?', [studentId]));
}

// The threads a person sees, newest activity first. Students and advisers always get their own threads created for them.
async function listFor(user) {
  if (user.role === 'student') {
    const g = await L.groupOfStudent(user.id);
    if (g) await ensureGroupThread(g);
    if (g?.adviser_id) await ensureAdviserThread(user.workspace_id, user.id);
    await ensureDirectThread(user.workspace_id, user.id);
  } else if (user.role === 'adviser') {
    for (const g of await db.all('SELECT * FROM thesis_groups WHERE adviser_id = ?', [user.id])) {
      await ensureGroupThread(g);
      for (const m of await L.membersOf(g.id)) await ensureAdviserThread(g.workspace_id, m.id);
    }
    await ensureDirectThread(user.workspace_id, user.id);
  }
  const v = visible(user);
  return db.all(
    `SELECT c.*, g.name AS group_name, u.name AS user_name, u.role AS user_role, s.name AS student_name, ${ADVISER_NAME} AS adviser_name, ${CLASS_COLS},
       (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.hidden = 0 ORDER BY m.id DESC LIMIT 1) AS last_body,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS total,
       ${unreadSql} AS unread
     FROM conversations c LEFT JOIN thesis_groups g ON g.id = c.group_id LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users s ON s.id = c.student_id
     WHERE ${v.sql} AND (c.kind = 'group' OR (c.kind = 'direct' AND u.active = 1) OR (c.kind = 'adviser' AND s.active = 1))
     ORDER BY unread DESC, (c.last_at IS NULL), COALESCE(c.last_at, c.created_at) DESC, c.id DESC`,
    [user.id, user.id, ...v.args]
  );
}

// One thread if the user may open it, otherwise undefined.
async function openFor(user, id) {
  const v = visible(user);
  return db.get(
    `SELECT c.*, g.name AS group_name, g.adviser_id AS group_adviser, u.name AS user_name, u.role AS user_role, s.name AS student_name, ${ADVISER_NAME} AS adviser_name, ${CLASS_COLS}
     FROM conversations c LEFT JOIN thesis_groups g ON g.id = c.group_id LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users s ON s.id = c.student_id
     WHERE c.id = ? AND ${v.sql}`,
    [Number(id), ...v.args]
  );
}

const titleOf = (c, user) => (c.kind === 'group' ? c.group_name : c.kind === 'adviser' ? (user.role === 'student' ? `Adviser: ${c.adviser_name}` : c.student_name) : user.role === 'admin' ? `${c.user_name} (${L.ROLE_LABEL[c.user_role].toLowerCase()})` : 'Coordinator');

// "IT · 4th year · 4B" for a group thread, an adviser thread (the student) or a coordinator thread with a student; empty otherwise.
const classOf = (c) => {
  const p = c.kind === 'group' ? 'g' : c.kind === 'adviser' ? 's' : c.user_role === 'student' ? 'u' : null;
  return p ? L.classLabel({ course: c[`${p}_course`], year_level: c[`${p}_year`], section: c[`${p}_section`] }) : '';
};

async function messagesOf(c, { after = 0, limit = 100 } = {}) {
  const rows = await db.all(
    `SELECT m.id, m.body, m.hidden, m.created_at, m.sender_id, m.file_name, u.name AS sender_name, u.role AS sender_role, u.course, u.year_level, u.section
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
  if (c.kind === 'adviser') {
    const ids = new Set([c.student_id]);
    const g = await L.groupOfStudent(c.student_id);
    if (g?.adviser_id) ids.add(g.adviser_id);
    return [...ids];
  }
  const ids = new Set((await db.all("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND workspace_id = ?", [c.workspace_id])).map((r) => r.id));
  if (c.kind === 'direct') ids.add(c.user_id);
  else {
    for (const m of await L.membersOf(c.group_id)) ids.add(m.id);
    if (c.group_adviser) ids.add(c.group_adviser);
  }
  return [...ids];
}

// Saves a message and tells the others once per thread, not once per message.
async function send(c, sender, body, file = null) {
  const r = await db.run('INSERT INTO messages (conversation_id, sender_id, body, file_name, file_stored) VALUES (?, ?, ?, ?, ?)',
    [c.id, sender.id, body, file ? file.originalname : null, file ? file.filename : null]);
  await db.run('UPDATE conversations SET last_at = NOW() WHERE id = ?', [c.id]);
  await markRead(c, sender);
  const link = `/messages/${c.id}`;
  const where = c.kind === 'group' ? c.group_name : c.kind === 'adviser' ? 'private adviser chat' : sender.role === 'admin' ? 'a private message' : `${sender.name}’s private thread`;
  for (const id of await participants(c)) {
    if (id === sender.id) continue;
    if (await db.get('SELECT 1 FROM notifications WHERE user_id = ? AND link = ? AND is_read = 0', [id, link])) continue;
    await L.notify(id, `New message from ${sender.name} (${where}).`, link, sender.role === 'admin' ? 'coordinator' : sender.role);
  }
  return r.lastInsertRowid;
}

// More than 20 messages in a minute is a flood, not a conversation.
const tooFast = async (user) => (await db.get('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE)', [user.id])).n >= 20;

module.exports = { MAX_LENGTH, visible, unreadCount, listFor, openFor, titleOf, classOf, messagesOf, markRead, send, tooFast, ensureGroupThread, ensureDirectThread };
