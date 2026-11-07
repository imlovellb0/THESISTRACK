// The panel member's pages: read-only. They see the groups they sit on the panel for, the defense schedule and the submitted files.
const router = require('express').Router();
const db = require('../db');
const L = require('../lib');

const myGroup = (req, id) =>
  db.get('SELECT g.* FROM thesis_groups g JOIN group_panelists p ON p.group_id = g.id WHERE g.id = ? AND p.panel_id = ?', [Number(id), req.user.id]);

router.get('/', async (req, res) => {
  const groups = await Promise.all(
    (await db.all(
      `SELECT g.* FROM thesis_groups g JOIN group_panelists p ON p.group_id = g.id
       WHERE p.panel_id = ? ORDER BY g.defense_date IS NULL, g.defense_date, g.defense_time, g.name`,
      [req.user.id]
    )).map(async (g) => ({ ...(await L.summarize(g)), panel: await L.panelOf(g.id) }))
  );
  const today = L.today();
  const upcoming = groups.filter((g) => g.defense_date && g.defense_date >= today);
  res.render('panel/dashboard', {
    title: 'My panels', groups,
    upcoming,
    // The "Upcoming defenses" tile links here with ?show=upcoming.
    filter: req.query.show === 'upcoming' ? 'upcoming' : '',
    shown: req.query.show === 'upcoming' ? upcoming : groups,
  });
});

router.get('/group/:id', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return res.status(403).render('error', { title: 'No access', message: 'You are not on the panel of this group.' });
  const s = await L.summarize(g);
  const sheet = await db.get('SELECT * FROM panel_grades WHERE group_id = ? AND panel_id = ?', [g.id, req.user.id]);
  // A started sheet keeps the criteria it was saved with; before that, the workspace's current rubric is used.
  const scores = sheet ? await L.gradeScores(sheet.id) : [];
  res.render('panel/group', {
    title: g.name, g: s, chapters: s.chapters, members: await L.membersOf(g.id), panel: await L.panelOf(g.id),
    sheet, rows: scores.length ? scores.map((r) => ({ title: r.title, max: r.max_score, score: r.score })) : (await L.rubricOf(req.user.workspace_id)).map((c) => ({ ...c, score: null })),
    canGrade: !!g.defense_date && g.defense_date <= L.today(),
  });
});

// Save a draft or submit the score sheet. A submitted sheet is locked until the coordinator returns it.
router.post('/group/:id/grade', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return res.status(403).render('error', { title: 'No access', message: 'You are not on the panel of this group.' });
  const back = `/panel/group/${g.id}#grade`;
  const stop = (msg) => { req.flash('error', msg); return res.redirect(back); };
  if (!g.defense_date || g.defense_date > L.today()) return stop('Grading opens on the defense date.');
  const sheet = await db.get('SELECT * FROM panel_grades WHERE group_id = ? AND panel_id = ?', [g.id, req.user.id]);
  if (sheet && sheet.status === 'Submitted') return stop('This sheet was already submitted. Ask the coordinator to return it if it needs a change.');

  const submit = req.body.action === 'submit';
  const rubric = sheet ? (await L.gradeScores(sheet.id)).map((r) => ({ title: r.title, max: r.max_score })) : await L.rubricOf(req.user.workspace_id);
  const given = [].concat(req.body.score || []);
  const scores = [];
  for (let i = 0; i < rubric.length; i++) {
    const raw = String(given[i] ?? '').trim();
    if (raw === '') { scores.push(null); continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > rubric[i].max) return stop(`${rubric[i].title}: enter a score from 0 to ${rubric[i].max}.`);
    scores.push(Math.round(n * 100) / 100);
  }
  const outcome = L.OUTCOMES.includes(req.body.outcome) ? req.body.outcome : null;
  const remarks = String(req.body.remarks || '').trim().slice(0, 2000);
  if (submit && scores.some((s) => s === null)) return stop('Score every criterion before you submit.');
  if (submit && !outcome) return stop('Choose an outcome before you submit.');
  const total = scores.reduce((a, s) => a + (s || 0), 0);

  await db.transaction(async () => {
    let id = sheet && sheet.id;
    if (!id) id = (await db.run('INSERT INTO panel_grades (group_id, panel_id) VALUES (?, ?)', [g.id, req.user.id])).lastInsertRowid;
    await db.run(
      `UPDATE panel_grades SET status = ?, outcome = ?, remarks = ?, total = ?, return_note = ${submit ? 'NULL' : 'return_note'}, submitted_at = ${submit ? 'NOW()' : 'submitted_at'}, updated_at = NOW() WHERE id = ?`,
      [submit ? 'Submitted' : sheet ? sheet.status : 'Draft', outcome, remarks || null, total, id]
    );
    await db.run('DELETE FROM panel_grade_scores WHERE grade_id = ?', [id]);
    for (let i = 0; i < rubric.length; i++) await db.run('INSERT INTO panel_grade_scores (grade_id, position, title, max_score, score) VALUES (?, ?, ?, ?, ?)', [id, i, rubric[i].title, rubric[i].max, scores[i]]);
  });
  if (submit) {
    await L.log(req.user.id, `submitted the panel grade for ${g.name}`);
    await L.notifyAdmins(req.user.workspace_id, `${req.user.name} submitted a panel grade for ${g.name}.`, `/admin/grades/${g.id}`, 'system');
    if (g.adviser_id) await L.notify(g.adviser_id, `${req.user.name} submitted a panel grade for ${g.name}.`, `/adviser/group/${g.id}#panel-results`, 'panel');
    req.flash('ok', 'Your grade was submitted to the coordinator.');
  } else {
    req.flash('ok', 'Draft saved. Nothing is sent to the coordinator until you submit.');
  }
  res.redirect(back);
});

module.exports = router;
