// Shared helpers: constants, date helpers, status logic and common queries.
const db = require('./db');

const CH_NAMES = [
  'Introduction',
  'Review of Related Literature',
  'Methodology',
  'Results and Discussion',
  'Summary and Conclusion',
];

// Chapter workflow: none -> submitted -> approved | revision | rejected
const STATUS = {
  none: { label: 'Not submitted', tone: 'muted' },
  submitted: { label: 'Pending review', tone: 'info' },
  revision: { label: 'For revision', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  rejected: { label: 'Rejected', tone: 'bad' },
};

const MAX_GROUP_SIZE = 6; // members plus open invitations

// A general outline of what each chapter usually contains. The adviser's own format always comes first.
const CH_GUIDE = [
  ['Background of the study', 'Statement of the problem and the objectives', 'Scope and limitations', 'Significance of the study', 'Definition of terms'],
  ['Related literature, local and foreign', 'Related studies', 'Synthesis and the gap your study fills', 'Theoretical and conceptual framework'],
  ['Research design', 'Respondents and sampling', 'Research instruments and how data is gathered', 'System development method, if you build a system', 'Data analysis and ethical considerations'],
  ['Presentation of data, one table or figure per objective', 'Analysis and interpretation', 'Discussion against the literature in Chapter 2', 'Testing and evaluation results, if you build a system'],
  ['Summary of findings', 'Conclusions that answer each objective', 'Recommendations', 'References and appendices complete'],
];

const SLOTS = ['09:00', '10:00', '13:00', '14:00', '15:00'];
const ROLE_LABEL = { student: 'Student', adviser: 'Adviser', panel: 'Panel member', admin: 'Coordinator', superadmin: 'System administrator' };

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dateStr(new Date());
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return dateStr(d);
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
const fmtDate = (s) => {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
};
const fmtDateTime = (s) => {
  if (!s) return '';
  return `${fmtDate(s)}, ${String(s).slice(11, 16)}`;
};

// ---------- status logic ----------
const isOverdue = (c) =>
  !!c.deadline && c.deadline < today() && ['none', 'revision', 'rejected'].includes(c.status);
const healthOf = (chs) =>
  chs.length && chs.every((c) => c.status === 'approved') ? 'completed' : chs.some(isOverdue) ? 'delayed' : 'on track';

// ---------- small HTML helpers (output is built only from fixed constants, so it is safe to print raw) ----------
const pill = (k) => `<span class="pill ${STATUS[k].tone}">${STATUS[k].label}</span>`;
const hpill = (h) =>
  `<span class="pill ${h === 'completed' ? 'good' : h === 'delayed' ? 'bad' : 'info'}">${h === 'on track' ? 'On track' : h[0].toUpperCase() + h.slice(1)}</span>`;
const strip = (chs) => `<div class="strip" aria-hidden="true">${chs.map((c) => `<i class="seg ${c.status}"></i>`).join('')}</div>`;
const bar = (n) => `<div class="prog"><div class="bar"><i style="width:${n * 20}%"></i></div><b>${n}/5</b></div>`;

// ---------- common queries (all async) ----------
const chaptersOf = (groupId) =>
  db.all(
    `SELECT c.*,
      (SELECT COUNT(*) FROM submissions s WHERE s.chapter_id = c.id) AS versions,
      (SELECT id FROM submissions s WHERE s.chapter_id = c.id ORDER BY version_no DESC LIMIT 1) AS latest_id,
      (SELECT original_name FROM submissions s WHERE s.chapter_id = c.id ORDER BY version_no DESC LIMIT 1) AS latest_name
     FROM chapters c WHERE c.group_id = ? ORDER BY c.number`,
    [groupId]
  );
const membersOf = (groupId) =>
  db.all(
    `SELECT u.id, u.name, u.email, u.avatar, (g.leader_id = u.id) AS is_leader, m.joined_at
       FROM users u JOIN group_members m ON m.student_id = u.id JOIN thesis_groups g ON g.id = m.group_id
      WHERE m.group_id = ? ORDER BY is_leader DESC, u.name`,
    [groupId]
  );
const memberCount = async (groupId) =>
  (await db.get('SELECT (SELECT COUNT(*) FROM group_members WHERE group_id = ?) + (SELECT COUNT(*) FROM group_invites WHERE group_id = ?) AS n', [groupId, groupId])).n;
const panelOf = (groupId) =>
  db.all('SELECT u.id, u.name FROM users u JOIN group_panelists p ON p.panel_id = u.id WHERE p.group_id = ? ORDER BY u.name', [groupId]);
const groupOfStudent = (userId) =>
  db.get('SELECT g.* FROM thesis_groups g JOIN group_members m ON m.group_id = g.id WHERE m.student_id = ?', [userId]);
const pendingRequestOf = (groupId) =>
  db.get("SELECT * FROM adviser_requests WHERE group_id = ? AND status = 'Pending' ORDER BY id DESC LIMIT 1", [groupId]);
const requestsOf = (groupId) =>
  db.all('SELECT r.*, u.name AS adviser_name FROM adviser_requests r JOIN users u ON u.id = r.adviser_id WHERE r.group_id = ? ORDER BY r.id DESC', [groupId]);
// Tells the coordinator of one workspace (never the coordinators of other workspaces).
const notifyAdmins = async (workspaceId, message, link, source) => {
  for (const a of await db.all("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND workspace_id = ?", [workspaceId])) await notify(a.id, message, link, source);
};
// The workspace's coordinator, so students can see who runs their thesis course.
const coordinatorOf = (workspaceId) => db.get("SELECT id, name, avatar FROM users WHERE role = 'admin' AND active = 1 AND workspace_id = ? ORDER BY id LIMIT 1", [workspaceId]);
const userName = async (id) => (await db.get('SELECT name FROM users WHERE id = ?', [id]))?.name || '';

// A group plus the numbers every list needs.
async function summarize(g) {
  const chapters = await chaptersOf(g.id);
  return {
    ...g,
    chapters,
    adviser_name: g.adviser_id ? await userName(g.adviser_id) : null,
    approved: chapters.filter((c) => c.status === 'approved').length,
    pending: chapters.filter((c) => c.status === 'submitted').length,
    health: healthOf(chapters),
    overdue: chapters.find(isOverdue) || null,
  };
}

async function createChapters(groupId) {
  for (let n = 1; n <= 5; n++) {
    await db.run('INSERT INTO chapters (group_id, number, deadline) VALUES (?, ?, ?)', [groupId, n, addDays(n * 21)]);
  }
}

async function canAccessGroup(user, groupId) {
  if (!user) return false;
  if (user.role === 'admin') return !!(await db.get('SELECT 1 FROM thesis_groups WHERE id = ? AND workspace_id = ?', [groupId, user.workspace_id]));
  if (user.role === 'student') return !!(await db.get('SELECT 1 FROM group_members WHERE group_id = ? AND student_id = ?', [groupId, user.id]));
  if (user.role === 'adviser') return !!(await db.get('SELECT 1 FROM thesis_groups WHERE id = ? AND adviser_id = ?', [groupId, user.id]));
  return false;
}

// Days from today until a 'YYYY-MM-DD' date. Negative means the date has passed.
const daysUntil = (s) => {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  const t = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
};
const inDays = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`);

// What the group should do next: the chapter with the nearest deadline that is still waiting on the students.
function nextUp(chapters) {
  if (chapters.length && chapters.every((c) => c.status === 'approved')) return { kind: 'done' };
  const todo = chapters.filter((c) => ['none', 'revision', 'rejected'].includes(c.status) && c.deadline).sort((a, b) => (a.deadline < b.deadline ? -1 : 1))[0];
  if (todo) {
    const days = daysUntil(todo.deadline);
    return { kind: days < 0 ? 'overdue' : 'due', chapter: todo, days };
  }
  const waiting = chapters.find((c) => c.status === 'submitted');
  return waiting ? { kind: 'review', chapter: waiting } : { kind: 'none' };
}

// The five first steps shown to a new student. g and chapters are null/empty before the student is in a group.
const checklist = (me, g, chapters, consultCount) => [
  { label: 'Add a profile photo', done: !!me.avatar, href: '/profile' },
  { label: 'Create or join a thesis group', done: !!g, href: '/student' },
  { label: 'Get your adviser assigned', done: !!(g && g.adviser_id), href: g ? '/student' : null },
  { label: 'Submit Chapter 1', done: !!(chapters && chapters[0] && chapters[0].status !== 'none'), href: g ? '/student/chapter/1' : null },
  { label: 'Request a consultation', done: consultCount > 0, href: g ? '/student#consult' : null },
];

// Recent happenings for one group, newest first, built from the records the app already keeps.
async function groupFeed(groupId, limit = 8) {
  const q = (sql) => db.all(sql, [groupId]);
  const items = [
    ...(await q(`SELECT s.uploaded_at AS at, CONCAT(COALESCE(u.name, 'Someone'), ' uploaded Chapter ', c.number, ' v', s.version_no) AS text, c.number AS ch
                   FROM submissions s JOIN chapters c ON c.id = s.chapter_id LEFT JOIN users u ON u.id = s.uploaded_by WHERE c.group_id = ?`)),
    ...(await q(`SELECT cm.created_at AS at, CONCAT(u.name, ' commented on Chapter ', c.number) AS text, c.number AS ch
                   FROM comments cm JOIN chapters c ON c.id = cm.chapter_id JOIN users u ON u.id = cm.author_id WHERE c.group_id = ?`)),
    ...(await q(`SELECT m.joined_at AS at, CONCAT(u.name, ' joined the group') AS text, NULL AS ch
                   FROM group_members m JOIN users u ON u.id = m.student_id WHERE m.group_id = ? AND m.joined_at IS NOT NULL`)),
    ...(await q(`SELECT r.decided_at AS at, CONCAT(u.name, ' became your adviser') AS text, NULL AS ch
                   FROM adviser_requests r JOIN users u ON u.id = r.adviser_id WHERE r.group_id = ? AND r.status = 'Accepted' AND r.decided_at IS NOT NULL`)),
    ...(await q(`SELECT k.created_at AS at, CONCAT('Consultation on ', k.date, ' at ', k.slot, ' was ', LOWER(k.status)) AS text, NULL AS ch
                   FROM consultations k WHERE k.group_id = ?`)),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

// A student who registers with an email the group leaders had invited joins that group straight away.
// Returns the name of the group they joined, or null. All their invitations in this workspace are used up.
async function claimInvites(userId, email, workspaceId) {
  const invites = await db.all(
    'SELECT i.id, i.group_id, g.name FROM group_invites i JOIN thesis_groups g ON g.id = i.group_id WHERE i.email = ? AND g.workspace_id = ? ORDER BY i.id',
    [email, workspaceId]
  );
  let joined = null;
  for (const inv of invites) {
    const members = (await db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', [inv.group_id])).n;
    if (!joined && members < MAX_GROUP_SIZE) {
      await db.run('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [inv.group_id, userId]);
      joined = inv;
    }
    await db.run('DELETE FROM group_invites WHERE id = ?', [inv.id]);
  }
  if (joined) {
    const name = await userName(userId);
    await notifyGroup(joined.group_id, `${name} created an account and joined ${joined.name} from your invitation.`, '/student', userId, 'student');
  }
  return joined ? joined.name : null;
}

// ---------- logging and notifications ----------
// The entry belongs to the workspace of the person who did it.
const log = (actorId, action) =>
  db.run('INSERT INTO activity_log (actor_id, action, workspace_id) VALUES (?, ?, (SELECT workspace_id FROM users WHERE id = ?))', [actorId, action, actorId]);
// source is who the message is from: 'adviser', 'coordinator', 'student' or 'system' (reminders). The notifications page groups by it.
const notify = (userId, message, link, source) =>
  db.run('INSERT INTO notifications (user_id, message, link, source) VALUES (?, ?, ?, ?)', [userId, message, link || null, source || 'system']);
const notifyGroup = async (groupId, message, link, exceptId, source) => {
  for (const m of await membersOf(groupId)) if (m.id !== exceptId) await notify(m.id, message, link, source);
};

module.exports = {
  CH_NAMES, CH_GUIDE, MAX_GROUP_SIZE, STATUS, SLOTS, ROLE_LABEL,
  daysUntil, inDays, nextUp, checklist, groupFeed, claimInvites, memberCount, coordinatorOf,
  today, addDays, isDate, fmtDate, fmtDateTime,
  isOverdue, healthOf,
  pill, hpill, strip, bar,
  chaptersOf, membersOf, panelOf, groupOfStudent, pendingRequestOf, requestsOf, notifyAdmins, userName, summarize, createChapters, canAccessGroup,
  log, notify, notifyGroup,
};
