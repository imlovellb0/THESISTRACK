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
  rejected: { label: 'Disapproved', tone: 'bad' },
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

// A manually typed time of day, 24-hour 'HH:MM'.
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
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
const bar = (n, total = 5) => `<div class="prog"><div class="bar"><i style="width:${total ? Math.round((n / total) * 100) : 0}%"></i></div><b>${n}/${total}</b></div>`;

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

// 'endorsed' once the adviser gave the final yes, 'ready' when every chapter is approved and the yes is still due, else ''.
const readinessOf = (g, chapters) =>
  !chapters.length || !chapters.every((c) => c.status === 'approved') ? '' : g.endorsed_at ? 'endorsed' : 'ready';
const readyPill = (r) =>
  r === 'endorsed' ? '<span class="pill good">Endorsed for defense</span>' : r === 'ready' ? '<span class="pill info">Ready to defend</span>' : '';

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
    readiness: readinessOf(g, chapters),
  };
}

// A new group gets one chapter for every entry in its workspace's contents (five unless the coordinator changed them).
async function createChapters(groupId, workspaceId) {
  const total = (await contentsOf(workspaceId)).length;
  for (let n = 1; n <= total; n++) {
    await db.run('INSERT INTO chapters (group_id, number, deadline) VALUES (?, ?, ?)', [groupId, n, addDays(n * 21)]);
  }
}

const markedFilesOf = (chapterId) =>
  db.all('SELECT f.*, u.name AS by_name, s.version_no FROM adviser_files f JOIN users u ON u.id = f.uploaded_by LEFT JOIN submissions s ON s.id = f.submission_id WHERE f.chapter_id = ? ORDER BY f.id DESC', [chapterId]);

async function canAccessGroup(user, groupId) {
  if (!user) return false;
  if (user.role === 'admin') return !!(await db.get('SELECT 1 FROM thesis_groups WHERE id = ? AND workspace_id = ?', [groupId, user.workspace_id]));
  if (user.role === 'student') return !!(await db.get('SELECT 1 FROM group_members WHERE group_id = ? AND student_id = ?', [groupId, user.id]));
  if (user.role === 'adviser') return !!(await db.get('SELECT 1 FROM thesis_groups WHERE id = ? AND adviser_id = ?', [groupId, user.id]));
  // A panel member can open the files of the groups they sit on the panel for.
  if (user.role === 'panel') return !!(await db.get('SELECT 1 FROM group_panelists WHERE group_id = ? AND panel_id = ?', [groupId, user.id]));
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
// source is who the message is from: 'adviser', 'coordinator', 'student', 'panel' or 'system' (reminders). The notifications page groups by it.
const notify = (userId, message, link, source) =>
  db.run('INSERT INTO notifications (user_id, message, link, source) VALUES (?, ?, ?, ?)', [userId, message, link || null, source || 'system']);
const notifyGroup = async (groupId, message, link, exceptId, source) => {
  for (const m of await membersOf(groupId)) if (m.id !== exceptId) await notify(m.id, message, link, source);
};

// The table of contents: each workspace can rename its chapters and rewrite the outline under each one.
// It is saved as JSON in the settings table; anything not saved falls back to the standard titles above.
const CONTENTS_KEY = (wid) => `contents_${wid}`;
async function contentsOf(wid) {
  let saved = [];
  try { saved = wid ? JSON.parse(await db.getSetting(CONTENTS_KEY(wid), '[]')) : []; } catch { saved = []; }
  if (Array.isArray(saved) && saved.length) {
    return saved.map((c, i) => ({
      title: String((c && c.title) || '').trim() || CH_NAMES[i] || `Chapter ${i + 1}`,
      items: Array.isArray(c && c.items) ? c.items : (CH_GUIDE[i] || []),
    }));
  }
  return CH_NAMES.map((title, i) => ({ title, items: CH_GUIDE[i] }));
}
const saveContents = (wid, list) => db.setSetting(CONTENTS_KEY(wid), JSON.stringify(list));

// The panel's score sheet: criteria with a maximum each, always adding up to 100. Each workspace can change them.
const DEFAULT_RUBRIC = [
  { title: 'Paper / documentation', max: 30 },
  { title: 'System or output', max: 30 },
  { title: 'Oral presentation', max: 20 },
  { title: 'Q&A / defense of work', max: 20 },
];
const OUTCOMES = ['Passed', 'Passed with revisions', 'Failed'];
async function rubricOf(wid) {
  let saved = [];
  try { saved = wid ? JSON.parse(await db.getSetting(`rubric_${wid}`, '[]')) : []; } catch { saved = []; }
  const ok = Array.isArray(saved) && saved.length && saved.every((c) => c && c.title && Number.isInteger(c.max) && c.max > 0);
  return ok ? saved : DEFAULT_RUBRIC;
}
const saveRubric = (wid, list) => db.setSetting(`rubric_${wid}`, JSON.stringify(list));
const gradeScores = (gradeId) => db.all('SELECT position, title, max_score, score FROM panel_grade_scores WHERE grade_id = ? ORDER BY position', [gradeId]);

// The panelists' submitted grade sheets for a group, with their scores. The group's adviser can read these (read only).
async function submittedSheetsOf(groupId) {
  const sheets = await db.all("SELECT s.*, u.name AS panel_name FROM panel_grades s JOIN users u ON u.id = s.panel_id WHERE s.group_id = ? AND s.status = 'Submitted' ORDER BY u.name", [groupId]);
  for (const s of sheets) s.scores = await gradeScores(s.id);
  return sheets;
}

// The released defense result as the group sees it: final outcome, average, anonymous panel remarks. Null until released.
async function resultOf(g) {
  if (!g.result_released_at) return null;
  const sheets = await db.all("SELECT id, remarks FROM panel_grades WHERE group_id = ? AND status = 'Submitted' ORDER BY id", [g.id]);
  const byCriterion = new Map();
  for (const s of sheets) {
    for (const r of await gradeScores(s.id)) {
      const c = byCriterion.get(r.position) || { title: r.title, max: r.max_score, sum: 0, n: 0 };
      if (r.score !== null) { c.sum += Number(r.score); c.n++; }
      byCriterion.set(r.position, c);
    }
  }
  return {
    outcome: g.result_outcome, note: g.result_note, average: g.result_average === null ? null : Number(g.result_average), releasedAt: g.result_released_at,
    criteria: [...byCriterion.values()].map((c) => ({ title: c.title, max: c.max, avg: c.n ? c.sum / c.n : null })),
    remarks: sheets.map((s) => s.remarks).filter(Boolean),
  };
}

const YEAR_LEVELS = { 1: '1st year', 2: '2nd year', 3: '3rd year', 4: '4th year' };
// "IT · 4th year · 4B" from a user or group row; empty when nothing was recorded.
const classLabel = (r) => [r.course, YEAR_LEVELS[r.year_level], r.section].filter(Boolean).join(' · ');
// Reads the three class fields from a form body. Returns { value } or { error }.
const readClass = (body, optional = false) => {
  const course = String(body.course || '').trim().slice(0, 60);
  const year = Number(body.year_level);
  const section = String(body.section || '').trim().toUpperCase().slice(0, 10);
  if (optional && !course && !body.year_level && !section) return { value: { course: null, year_level: null, section: null } };
  if (!course) return { error: 'Enter your course (for example IT).' };
  if (!YEAR_LEVELS[year]) return { error: 'Choose your year level.' };
  if (!section) return { error: 'Enter your section (for example 4B).' };
  return { value: { course, year_level: year, section } };
};

module.exports = {
  YEAR_LEVELS, classLabel, readClass,
  contentsOf, saveContents, rubricOf, saveRubric, gradeScores, DEFAULT_RUBRIC, OUTCOMES,
  resultOf, submittedSheetsOf, readinessOf, readyPill,
  CH_NAMES, CH_GUIDE, MAX_GROUP_SIZE, STATUS, isTime, ROLE_LABEL,
  daysUntil, inDays, nextUp, checklist, groupFeed, claimInvites, memberCount, coordinatorOf,
  today, addDays, isDate, fmtDate, fmtDateTime,
  isOverdue, healthOf,
  pill, hpill, strip, bar,
  markedFilesOf, chaptersOf, membersOf, panelOf, groupOfStudent, pendingRequestOf, requestsOf, notifyAdmins, userName, summarize, createChapters, canAccessGroup,
  log, notify, notifyGroup,
};
