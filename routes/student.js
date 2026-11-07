const router = require('express').Router();
const db = require('../db');
const L = require('../lib');
const { csrfCheck } = require('../middleware');

const { upload, removeFile, looksLikeDocument } = require('../uploads');

const me = (req) => db.get('SELECT id, name, email, student_no, avatar FROM users WHERE id = ?', [req.user.id]);

const myGroup = (req) => L.groupOfStudent(req.user.id);
const chapterOf = (groupId, n) => db.get('SELECT * FROM chapters WHERE group_id = ? AND number = ?', [groupId, n]);

// Students without a group can only see the home page, their profile and the create / join pages.
const NO_GROUP_PATHS = ['/', '/group', '/group/new', '/group/join', '/profile'];
router.use(async (req, res, next) => {
  req.group = await myGroup(req);
  req.isLeader = !!req.group && req.group.leader_id === req.user.id;
  const open = NO_GROUP_PATHS.includes(req.path) || req.path.startsWith('/join/');
  if (!req.group && !open) return res.redirect('/student');
  next();
});

// Only the leader may change who is in the group.
const leaderOnly = (req, res, next) => {
  if (req.isLeader) return next();
  req.flash('error', 'Only the group leader can do that.');
  res.redirect('/student');
};

const joinLinkOf = (req, code) => `${process.env.APP_URL || `${req.protocol}://${req.get('host')}`}/student/join/${code}`;

router.get('/', async (req, res) => {
  const g = req.group;
  const mine = await me(req);
  const notices = await db.all('SELECT * FROM announcements WHERE workspace_id = ? ORDER BY id DESC LIMIT 4', [req.user.workspace_id]);
  const coordinator = await L.coordinatorOf(req.user.workspace_id);
  if (!g) {
    return res.render('student/home', { title: 'Welcome', me: mine, notices, coordinator, steps: L.checklist(mine, null, [], 0) });
  }
  const chapters = await L.chaptersOf(g.id);
  const consults = await db.all('SELECT * FROM consultations WHERE group_id = ? ORDER BY date DESC, slot DESC LIMIT 6', [g.id]);
  const consultCount = (await db.get('SELECT COUNT(*) AS n FROM consultations WHERE group_id = ?', [g.id])).n;
  const steps = L.checklist(mine, g, chapters, consultCount);
  res.render('student/dashboard', {
    title: 'My thesis',
    g,
    chapters,
    health: L.healthOf(chapters),
    approved: chapters.filter((c) => c.status === 'approved').length,
    members: await L.membersOf(g.id),
    isLeader: req.isLeader,
    invites: req.isLeader ? await db.all('SELECT * FROM group_invites WHERE group_id = ? ORDER BY id', [g.id]) : [],
    joinLink: joinLinkOf(req, g.join_code),
    maxSize: L.MAX_GROUP_SIZE,
    coordinator,
    adviser: g.adviser_id ? await db.get('SELECT id, name, avatar FROM users WHERE id = ?', [g.adviser_id]) : null,
    pendingAdviser: await (async () => {
      const p = await L.pendingRequestOf(g.id);
      return p ? L.userName(p.adviser_id) : null;
    })(),
    consults,
    notices,
    openComments: (await db.get(
      'SELECT COUNT(*) AS n FROM comments cm JOIN chapters c ON c.id = cm.chapter_id WHERE c.group_id = ? AND cm.resolved = 0',
      [g.id]
    )).n,
    next: L.nextUp(chapters),
    steps,
    stepsLeft: steps.filter((s) => !s.done).length,
    defenseIn: g.defense_date ? L.daysUntil(g.defense_date) : null,
    feed: await L.groupFeed(g.id),
    result: await L.resultOf(g),
  });
});

// The profile page now lives at /profile for every role. The old address still works.
router.get('/profile', (req, res) => res.redirect('/profile'));

// ---------- adding people by email ----------
// A student who already has an account in this workspace is added at once. An email with no account yet becomes an invitation
// that links up automatically when that person registers. Returns what happened so the caller can report it.
async function addByEmail(g, email, actor) {
  if (!/^\S+@\S+\.\S+$/.test(email)) return { result: 'bad' };
  const u = await db.get('SELECT id, name, role, active, workspace_id FROM users WHERE email = ?', [email]);
  if (u) {
    if (u.workspace_id !== actor.workspace_id || u.role !== 'student' || !u.active) return { result: 'unavailable' };
    if (await db.get('SELECT 1 FROM group_members WHERE student_id = ?', [u.id])) return { result: 'taken', name: u.name };
    if ((await L.memberCount(g.id)) >= L.MAX_GROUP_SIZE) return { result: 'full' };
    await db.run('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [g.id, u.id]);
    await L.notify(u.id, `${actor.name} added you to ${g.name}.`, '/student', 'student');
    return { result: 'added', name: u.name };
  }
  if ((await L.memberCount(g.id)) >= L.MAX_GROUP_SIZE) return { result: 'full' };
  const r = await db.run('INSERT IGNORE INTO group_invites (group_id, email, invited_by) VALUES (?, ?, ?)', [g.id, email, actor.id]);
  return { result: r.changes ? 'invited' : 'already-invited' };
}

// One flash message for a list of results.
function reportAdds(req, results) {
  const by = (k) => results.filter((r) => r.result === k);
  const parts = [];
  if (by('added').length) parts.push(`Added: ${by('added').map((r) => r.name).join(', ')}.`);
  if (by('invited').length) parts.push(`Invited (no account yet, they join when they register): ${by('invited').map((r) => r.email).join(', ')}.`);
  if (by('already-invited').length) parts.push(`Already invited: ${by('already-invited').map((r) => r.email).join(', ')}.`);
  const skipped = [...by('bad'), ...by('unavailable'), ...by('taken')];
  if (skipped.length) parts.push(`Skipped (not a valid email, not a student of your workspace, or already in a group): ${skipped.map((r) => r.email).join(', ')}.`);
  if (by('full').length) parts.push(`The group is full (${L.MAX_GROUP_SIZE} people including invitations), so ${by('full').map((r) => r.email).join(', ')} could not be added.`);
  const bad = skipped.length || by('full').length;
  req.flash(bad ? 'warn' : 'ok', parts.join(' ') || 'Nothing to add.');
}

const parseEmails = (text) => [...new Set(String(text || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 20);

// ---------- create a group ----------
router.get('/group/new', (req, res) => {
  if (req.group) return res.redirect('/student');
  res.render('student/no-group', { title: 'Create your thesis group', form: {}, maxSize: L.MAX_GROUP_SIZE });
});

router.post('/group', async (req, res) => {
  if (req.group) {
    req.flash('error', 'You are already in a group.');
    return res.redirect('/student');
  }
  const name = String(req.body.name || '').trim().slice(0, 255);
  const title = String(req.body.title || '').trim().slice(0, 1000);
  if (!name || !title) {
    return res.status(400).render('student/no-group', { title: 'Create your thesis group', form: req.body, maxSize: L.MAX_GROUP_SIZE, error: 'Enter a group name and a thesis title.' });
  }
  const cls = L.readClass(req.body);
  if (cls.error) return res.status(400).render('student/no-group', { title: 'Create your thesis group', form: req.body, maxSize: L.MAX_GROUP_SIZE, error: cls.error });
  const results = [];
  let gid;
  await db.transaction(async () => {
    gid = (await db.run('INSERT INTO thesis_groups (name, title, course, year_level, section, workspace_id, leader_id, join_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, title, cls.value.course, cls.value.year_level, cls.value.section, req.user.workspace_id, req.user.id, await db.uniqueGroupCode()])).lastInsertRowid;
    await db.run('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [gid, req.user.id]);
    await L.createChapters(gid, req.user.workspace_id);
    for (const email of parseEmails(req.body.emails)) results.push({ email, ...(await addByEmail({ id: gid, name }, email, req.user)) });
  });
  await L.log(req.user.id, `created the group ${name}`);
  reportAdds(req, results);
  if (!results.length) req.flash('ok', 'Group created. You are the group leader. Share the join code so your teammates can join. The coordinator will assign your adviser.');
  res.redirect('/student');
});

// ---------- join a group with its code or link ----------
const wrongCodes = new Map(); // at most 10 wrong codes per student per 15 minutes
const tooManyTries = (id) => {
  const w = wrongCodes.get(id);
  if (!w || Date.now() - w.since > 15 * 60 * 1000) { wrongCodes.delete(id); return false; }
  return w.n >= 10;
};
const wrongCode = (id) => {
  const w = wrongCodes.get(id) || { n: 0, since: Date.now() };
  w.n++;
  wrongCodes.set(id, w);
};
const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
// The code only works inside the student's own workspace.
const groupByCode = (code, workspaceId) =>
  code ? db.get('SELECT * FROM thesis_groups WHERE join_code = ? AND workspace_id = ?', [code, workspaceId]) : null;

router.get('/join/:code', async (req, res) => {
  if (req.group) { req.flash('error', 'You are already in a group. Leave it first if you want to join another.'); return res.redirect('/student'); }
  const g = await groupByCode(cleanCode(req.params.code), req.user.workspace_id);
  if (!g) { req.flash('error', 'That join code is not valid. Ask your group leader for the current code.'); return res.redirect('/student'); }
  res.render('student/join', {
    title: 'Join a group', g, code: g.join_code,
    leader: await L.userName(g.leader_id), count: (await db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', [g.id])).n, full: (await L.memberCount(g.id)) >= L.MAX_GROUP_SIZE,
  });
});

router.post('/group/join', async (req, res) => {
  if (req.group) { req.flash('error', 'You are already in a group.'); return res.redirect('/student'); }
  if (tooManyTries(req.user.id)) { req.flash('error', 'Too many wrong codes. Wait 15 minutes and try again.'); return res.redirect('/student'); }
  const g = await groupByCode(cleanCode(req.body.code), req.user.workspace_id);
  if (!g) { wrongCode(req.user.id); req.flash('error', 'That join code is not valid. Check it with your group leader.'); return res.redirect('/student'); }
  if ((await L.memberCount(g.id)) >= L.MAX_GROUP_SIZE) { req.flash('error', `${g.name} is full.`); return res.redirect('/student'); }
  await db.transaction(async () => {
    await db.run('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [g.id, req.user.id]);
    // If the leader had also invited this email, that invitation is now used.
    await db.run('DELETE FROM group_invites WHERE email = ? AND group_id = ?', [req.user.email.toLowerCase(), g.id]);
  });
  await L.notifyGroup(g.id, `${req.user.name} joined ${g.name} with the group code.`, '/student', req.user.id, 'student');
  await L.log(req.user.id, `joined ${g.name} with its join code`);
  req.flash('ok', `You joined ${g.name}.`);
  res.redirect('/student');
});

// ---------- the leader manages the group ----------
router.post('/group/members', leaderOnly, async (req, res) => {
  const emails = parseEmails(req.body.email);
  if (!emails.length) { req.flash('error', 'Enter an email address.'); return res.redirect('/student'); }
  const results = [];
  for (const email of emails) results.push({ email, ...(await addByEmail(req.group, email, req.user)) });
  const added = results.filter((r) => r.result === 'added');
  if (added.length) await L.log(req.user.id, `added ${added.map((r) => r.name).join(', ')} to ${req.group.name}`);
  reportAdds(req, results);
  res.redirect('/student');
});

router.post('/group/class', leaderOnly, async (req, res) => {
  const cls = L.readClass(req.body);
  if (cls.error) req.flash('error', cls.error);
  else {
    await db.run('UPDATE thesis_groups SET course = ?, year_level = ?, section = ? WHERE id = ?', [cls.value.course, cls.value.year_level, cls.value.section, req.group.id]);
    await L.log(req.user.id, `updated the class of ${req.group.name}`);
    req.flash('ok', "The group's course, year level and section were saved.");
  }
  res.redirect('/student');
});

router.post('/group/invites/:id/cancel', leaderOnly, async (req, res) => {
  await db.run('DELETE FROM group_invites WHERE id = ? AND group_id = ?', [Number(req.params.id), req.group.id]);
  req.flash('ok', 'Invitation cancelled.');
  res.redirect('/student');
});

router.post('/group/code/new', leaderOnly, async (req, res) => {
  await db.run('UPDATE thesis_groups SET join_code = ? WHERE id = ?', [await db.uniqueGroupCode(), req.group.id]);
  await L.log(req.user.id, `made a new join code for ${req.group.name}`);
  req.flash('ok', 'New join code created. The old code and link no longer work.');
  res.redirect('/student');
});

const memberOf = (groupId, studentId) =>
  db.get('SELECT u.id, u.name FROM group_members m JOIN users u ON u.id = m.student_id WHERE m.group_id = ? AND m.student_id = ?', [groupId, Number(studentId)]);

router.post('/group/members/:id/remove', leaderOnly, async (req, res) => {
  const m = await memberOf(req.group.id, req.params.id);
  if (!m) req.flash('error', 'That person is not in your group.');
  else if (m.id === req.user.id) req.flash('error', 'To go yourself, use Leave group.');
  else {
    await db.run('DELETE FROM group_members WHERE group_id = ? AND student_id = ?', [req.group.id, m.id]);
    await L.notify(m.id, `${req.user.name} removed you from ${req.group.name}. You can create a new group or join another.`, '/student', 'student');
    await L.log(req.user.id, `removed ${m.name} from ${req.group.name}`);
    req.flash('ok', `${m.name} was removed from the group.`);
  }
  res.redirect('/student');
});

router.post('/group/members/:id/leader', leaderOnly, async (req, res) => {
  const m = await memberOf(req.group.id, req.params.id);
  if (!m || m.id === req.user.id) req.flash('error', 'Pick another member of your group.');
  else {
    await db.run('UPDATE thesis_groups SET leader_id = ? WHERE id = ?', [m.id, req.group.id]);
    await L.notifyGroup(req.group.id, `${m.name} is now the leader of ${req.group.name}.`, '/student', null, 'student');
    await L.log(req.user.id, `made ${m.name} the leader of ${req.group.name}`);
    req.flash('ok', `${m.name} is now the group leader.`);
  }
  res.redirect('/student');
});

// Any member can leave. A leader who leaves passes the role to the member who joined first. The last member cannot leave.
router.post('/group/leave', async (req, res) => {
  const others = (await db.all('SELECT student_id FROM group_members WHERE group_id = ? AND student_id != ? ORDER BY joined_at, student_id', [req.group.id, req.user.id])).map((r) => r.student_id);
  if (!others.length) {
    req.flash('error', 'You are the only member, so the group would be left with nobody. Ask the coordinator if the group should be removed, or invite a teammate first.');
    return res.redirect('/student');
  }
  const gname = req.group.name;
  await db.transaction(async () => {
    await db.run('DELETE FROM group_members WHERE group_id = ? AND student_id = ?', [req.group.id, req.user.id]);
    if (req.isLeader) await db.run('UPDATE thesis_groups SET leader_id = ? WHERE id = ?', [others[0], req.group.id]);
  });
  const note = req.isLeader ? `${req.user.name} left ${gname}. ${await L.userName(others[0])} is the new group leader.` : `${req.user.name} left ${gname}.`;
  await L.notifyGroup(req.group.id, note, '/student', null, 'student');
  await L.log(req.user.id, `left the group ${gname}`);
  req.flash('ok', `You left ${gname}. You can create a new group or join another.`);
  res.redirect('/student');
});

// ---------- one chapter: versions, feedback, upload ----------
router.get('/chapter/:n', async (req, res) => {
  const n = Number(req.params.n);
  const c = await chapterOf(req.group.id, n);
  if (!c) return res.status(404).render('error', { title: 'Not found', message: 'That chapter does not exist.' });
  res.render('student/chapter', {
    title: `Chapter ${n}`,
    g: req.group,
    c,
    versions: await db.all(
      'SELECT s.*, u.name AS by_name FROM submissions s LEFT JOIN users u ON u.id = s.uploaded_by WHERE s.chapter_id = ? ORDER BY s.version_no DESC',
      [c.id]
    ),
    comments: await db.all(
      'SELECT cm.*, u.name AS author FROM comments cm JOIN users u ON u.id = cm.author_id WHERE cm.chapter_id = ? ORDER BY cm.id',
      [c.id]
    ),
    marked: await L.markedFilesOf(c.id),
    canUpload: ['none', 'revision', 'rejected'].includes(c.status),
    guide: res.locals.chGuide[n - 1] || [],
  });
});

router.post(
  '/chapter/:n/upload',
  (req, res, next) =>
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      const msg = err.message === 'WRONG_TYPE' ? 'Upload a PDF, DOC or DOCX file.'
        : err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB.' : 'The upload failed. Try again.';
      req.flash('error', msg);
      res.redirect(`/student/chapter/${Number(req.params.n)}`);
    }),
  csrfCheck,
  async (req, res) => {
    const n = Number(req.params.n);
    const back = `/student/chapter/${n}`;
    const c = await chapterOf(req.group.id, n);
    if (!c) { removeFile(req.file); return res.redirect('/student'); }
    if (!req.file) { req.flash('error', 'Choose a file first.'); return res.redirect(back); }
    if (!looksLikeDocument(req.file)) {
      removeFile(req.file);
      req.flash('error', 'That file does not look like a real PDF or Word document. Check the file and try again.');
      return res.redirect(back);
    }
    if (!['none', 'revision', 'rejected'].includes(c.status)) {
      removeFile(req.file);
      req.flash('error', c.status === 'approved' ? 'This chapter is already approved.' : 'Wait for your adviser to review the current version.');
      return res.redirect(back);
    }
    const v = await db.transaction(async () => {
      const v = ((await db.get('SELECT MAX(version_no) AS v FROM submissions WHERE chapter_id = ?', [c.id])).v || 0) + 1;
      await db.run('INSERT INTO submissions (chapter_id, version_no, original_name, stored_name, uploaded_by) VALUES (?, ?, ?, ?, ?)',
        [c.id, v, req.file.originalname, req.file.filename, req.user.id]);
      await db.run("UPDATE chapters SET status = 'submitted' WHERE id = ?", [c.id]);
      return v;
    });
    await L.log(req.user.id, `submitted Chapter ${n} v${v} for ${req.group.name}`);
    if (req.group.adviser_id) await L.notify(req.group.adviser_id, `${req.group.name} submitted Chapter ${n} (v${v}) for review.`, `/adviser/group/${req.group.id}/chapter/${n}`, 'student');
    req.flash('ok', `Chapter ${n} v${v} was sent to your adviser.`);
    res.redirect(back);
  }
);

// ---------- mark feedback resolved or open again ----------
router.post('/comments/:id/resolve', async (req, res) => {
  const cm = await db.get(
    'SELECT cm.*, c.group_id, c.number FROM comments cm JOIN chapters c ON c.id = cm.chapter_id WHERE cm.id = ?',
    [Number(req.params.id)]
  );
  if (!cm || cm.group_id !== req.group.id) return res.redirect('/student');
  await db.run('UPDATE comments SET resolved = ? WHERE id = ?', [cm.resolved ? 0 : 1, cm.id]);
  res.redirect(`/student/chapter/${cm.number}`);
});

// ---------- ask for a consultation ----------
router.post('/consultations', async (req, res) => {
  const { date, slot } = req.body;
  const topic = String(req.body.topic || '').trim();
  if (!req.group.adviser_id) req.flash('error', 'You can book after the coordinator assigns your adviser.');
  else if (!L.isDate(date) || date < L.today()) req.flash('error', 'Pick a date from today onward.');
  else if (!L.isTime(slot)) req.flash('error', 'Enter a valid time for the consultation.');
  else if (!topic) req.flash('error', 'Add a topic for the meeting.');
  else {
    await db.run('INSERT INTO consultations (group_id, adviser_id, date, slot, topic) VALUES (?, ?, ?, ?, ?)',
      [req.group.id, req.group.adviser_id, date, slot, topic.slice(0, 200)]);
    await L.notify(req.group.adviser_id, `${req.group.name} requested a consultation on ${L.fmtDate(date)} at ${slot}.`, '/adviser', 'student');
    await L.log(req.user.id, `requested a consultation for ${req.group.name}`);
    req.flash('ok', 'Request sent to your adviser.');
  }
  res.redirect('/student');
});

module.exports = router;
