const router = require('express').Router();
const db = require('../db');
const L = require('../lib');
const { upload, removeFile, looksLikeDocument } = require('../uploads');
const { csrfCheck } = require('../middleware');
const fs = require('fs');
const path = require('path');

const myGroup = (req, id) => db.get('SELECT * FROM thesis_groups WHERE id = ? AND adviser_id = ?', [Number(id), req.user.id]);
const chapterOf = (gid, n) => db.get('SELECT * FROM chapters WHERE group_id = ? AND number = ?', [gid, Number(n)]);
const denied = (res) => res.status(403).render('error', { title: 'No access', message: 'This group is not assigned to you.' });

router.get('/', async (req, res) => {
  const groups = await Promise.all((await db.all('SELECT * FROM thesis_groups WHERE adviser_id = ? ORDER BY name', [req.user.id])).map(L.summarize));
  const requests = await db.all(
    `SELECT k.*, g.name AS group_name FROM consultations k JOIN thesis_groups g ON g.id = k.group_id
     WHERE k.adviser_id = ? AND k.status = 'Requested' ORDER BY k.date, k.slot`,
    [req.user.id]
  );
  const upcoming = await db.all(
    `SELECT k.*, g.name AS group_name FROM consultations k JOIN thesis_groups g ON g.id = k.group_id
     WHERE k.adviser_id = ? AND k.status = 'Confirmed' AND k.date >= ? ORDER BY k.date, k.slot`,
    [req.user.id, L.today()]
  );
  const assignments = await db.all(
    `SELECT r.*, g.name AS group_name, g.title AS group_title FROM adviser_requests r JOIN thesis_groups g ON g.id = r.group_id
     WHERE r.adviser_id = ? AND r.status = 'Pending' ORDER BY r.id`,
    [req.user.id]
  );
  for (const a of assignments) a.members = await L.membersOf(a.group_id);
  res.render('adviser/dashboard', {
    title: 'My groups', groups, requests, upcoming, assignments,
    pending: groups.reduce((n, g) => n + g.pending, 0),
    delayed: groups.filter((g) => g.health === 'delayed').length,
  });
});

// ---------- details behind the dashboard tiles ----------
// Pending reviews: every chapter of this adviser's groups that is waiting for a decision.
router.get('/pending', async (req, res) => {
  const items = await db.all(
    `SELECT c.number, c.deadline, g.id AS group_id, g.name AS group_name, g.title AS group_title,
            s.id AS file_id, s.original_name, s.version_no, s.uploaded_at
       FROM chapters c JOIN thesis_groups g ON g.id = c.group_id
       LEFT JOIN submissions s ON s.id = (SELECT id FROM submissions WHERE chapter_id = c.id ORDER BY version_no DESC LIMIT 1)
      WHERE g.adviser_id = ? AND c.status = 'submitted' ORDER BY s.uploaded_at, g.name, c.number`,
    [req.user.id]
  );
  res.render('adviser/pending', { title: 'Pending reviews', items });
});

// Consultation requests: the ones waiting for an answer, and the confirmed meetings coming up.
router.get('/consultations', async (req, res) => {
  const base = `SELECT k.*, g.name AS group_name FROM consultations k JOIN thesis_groups g ON g.id = k.group_id WHERE k.adviser_id = ?`;
  res.render('adviser/consultations', {
    title: 'Consultation requests',
    requests: await db.all(`${base} AND k.status = 'Requested' ORDER BY k.date, k.slot`, [req.user.id]),
    upcoming: await db.all(`${base} AND k.status = 'Confirmed' AND k.date >= ? ORDER BY k.date, k.slot`, [req.user.id, L.today()]),
  });
});

// Groups delayed: which chapter is overdue, since when, and how far along the group is.
router.get('/delayed', async (req, res) => {
  const all = await Promise.all((await db.all('SELECT * FROM thesis_groups WHERE adviser_id = ? ORDER BY name', [req.user.id])).map(L.summarize));
  const groups = all.filter((g) => g.health === 'delayed').map((g) => ({ ...g, overdueChapters: g.chapters.filter(L.isOverdue) }));
  res.render('adviser/delayed', { title: 'Groups delayed', groups });
});

// Accept or decline being a group's adviser. A decline needs a reason, which goes to the coordinator.
router.post('/assignments/:id', async (req, res) => {
  const r = await db.get(
    `SELECT r.*, g.name AS group_name FROM adviser_requests r JOIN thesis_groups g ON g.id = r.group_id
     WHERE r.id = ? AND r.adviser_id = ? AND r.status = 'Pending'`,
    [Number(req.params.id), req.user.id]
  );
  const decision = req.body.decision;
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!r || !['accept', 'decline'].includes(decision)) { req.flash('error', 'That request was not found or is already answered.'); return res.redirect('/adviser'); }
  if (decision === 'decline' && !reason) { req.flash('error', 'Write a reason so the coordinator knows why you declined.'); return res.redirect('/adviser'); }

  if (decision === 'accept') {
    await db.transaction(async () => {
      await db.run("UPDATE adviser_requests SET status = 'Accepted', decided_at = NOW() WHERE id = ?", [r.id]);
      await db.run('UPDATE thesis_groups SET adviser_id = ? WHERE id = ?', [req.user.id, r.group_id]);
    });
    await L.notifyGroup(r.group_id, `${req.user.name} accepted and is now your adviser.`, '/student', null, 'adviser');
    await L.notifyAdmins(req.user.workspace_id, `${req.user.name} accepted the advisory for ${r.group_name}.`, `/admin/groups/${r.group_id}`, 'adviser');
    await L.log(req.user.id, `accepted the advisory for ${r.group_name}`);
    req.flash('ok', `You are now the adviser of ${r.group_name}.`);
  } else {
    await db.run("UPDATE adviser_requests SET status = 'Declined', reason = ?, decided_at = NOW() WHERE id = ?", [reason, r.id]);
    await L.notifyAdmins(req.user.workspace_id, `${req.user.name} declined the advisory for ${r.group_name}.\nReason: ${reason}`, `/admin/groups/${r.group_id}`, 'adviser');
    await L.log(req.user.id, `declined the advisory for ${r.group_name}`);
    req.flash('ok', `You declined ${r.group_name}. The coordinator was told your reason.`);
  }
  res.redirect('/adviser');
});

router.get('/group/:id', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return denied(res);
  res.render('adviser/group', {
    title: g.name, g, chapters: await L.chaptersOf(g.id), members: await L.membersOf(g.id),
    readiness: L.readinessOf(g, await L.chaptersOf(g.id)),
    panelSheets: await L.submittedSheetsOf(g.id), result: await L.resultOf(g),
  });
});

// The adviser's final yes for the defense. It needs every chapter approved, and the coordinator cannot set a defense date without it.
router.post('/group/:id/endorse', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return denied(res);
  const back = `/adviser/group/${g.id}`;
  const chapters = await L.chaptersOf(g.id);
  if (g.endorsed_at) { req.flash('ok', 'This group is already endorsed.'); return res.redirect(back); }
  if (L.readinessOf(g, chapters) !== 'ready') { req.flash('error', 'Every chapter must be approved before you can endorse the group for the defense.'); return res.redirect(back); }
  await db.run('UPDATE thesis_groups SET endorsed_at = NOW(), endorsed_by = ? WHERE id = ?', [req.user.id, g.id]);
  await L.log(req.user.id, `endorsed ${g.name} for the defense`);
  await L.notifyGroup(g.id, `${req.user.name} endorsed your group for the defense. The coordinator can now set your defense date.`, '/student', null, 'adviser');
  await L.notifyAdmins(g.workspace_id, `${req.user.name} endorsed ${g.name} for the defense. You can set the defense date.`, `/admin/groups/${g.id}`, 'adviser');
  req.flash('ok', `${g.name} is endorsed for the defense. The group and the coordinator were notified.`);
  res.redirect(back);
});

// Taking the yes back is possible only while no defense date is set.
router.post('/group/:id/endorse/withdraw', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return denied(res);
  const back = `/adviser/group/${g.id}`;
  if (!g.endorsed_at) return res.redirect(back);
  if (g.defense_date) { req.flash('error', 'A defense date is already set. Ask the coordinator to clear it before you withdraw the endorsement.'); return res.redirect(back); }
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (!reason) { req.flash('error', 'Write the reason for withdrawing the endorsement.'); return res.redirect(back); }
  await db.run('UPDATE thesis_groups SET endorsed_at = NULL, endorsed_by = NULL WHERE id = ?', [g.id]);
  await L.log(req.user.id, `withdrew the defense endorsement of ${g.name}: ${reason}`);
  await L.notifyGroup(g.id, `${req.user.name} withdrew the defense endorsement. Reason: ${reason}`, '/student', null, 'adviser');
  await L.notifyAdmins(g.workspace_id, `${req.user.name} withdrew the defense endorsement of ${g.name}. Reason: ${reason}`, `/admin/groups/${g.id}`, 'adviser');
  req.flash('ok', 'The endorsement was withdrawn.');
  res.redirect(back);
});

router.get('/group/:id/chapter/:n', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return denied(res);
  const c = await chapterOf(g.id, req.params.n);
  if (!c) return res.status(404).render('error', { title: 'Not found', message: 'That chapter does not exist.' });
  res.render('adviser/review', {
    title: `${g.name}, Chapter ${c.number}`, g, c,
    versions: await db.all('SELECT s.*, u.name AS by_name FROM submissions s LEFT JOIN users u ON u.id = s.uploaded_by WHERE s.chapter_id = ? ORDER BY s.version_no DESC', [c.id]),
    comments: await db.all('SELECT cm.*, u.name AS author FROM comments cm JOIN users u ON u.id = cm.author_id WHERE cm.chapter_id = ? ORDER BY cm.id', [c.id]),
    marked: await L.markedFilesOf(c.id),
  });
});

// The adviser attaches a file for the group, for example the student's PDF marked up with what to revise.
router.post(
  '/group/:id/chapter/:n/marked',
  (req, res, next) =>
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      req.flash('error', err.message === 'WRONG_TYPE' ? 'Upload a PDF, DOC or DOCX file.'
        : err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB.' : 'The upload failed. Try again.');
      res.redirect(`/adviser/group/${Number(req.params.id)}/chapter/${Number(req.params.n)}`);
    }),
  csrfCheck,
  async (req, res) => {
    const g = await myGroup(req, req.params.id);
    if (!g) { removeFile(req.file); return denied(res); }
    const c = await chapterOf(g.id, req.params.n);
    const back = `/adviser/group/${g.id}/chapter/${req.params.n}`;
    if (!c) { removeFile(req.file); return res.redirect(back); }
    if (!req.file) { req.flash('error', 'Choose a file first.'); return res.redirect(back); }
    if (!looksLikeDocument(req.file)) {
      removeFile(req.file);
      req.flash('error', 'That file does not look like a real PDF or Word document.');
      return res.redirect(back);
    }
    const note = String(req.body.note || '').trim().slice(0, 500);
    const sid = Number(req.body.submission_id);
    const sub = sid && await db.get('SELECT id FROM submissions WHERE id = ? AND chapter_id = ?', [sid, c.id]);
    await db.run('INSERT INTO adviser_files (chapter_id, submission_id, uploaded_by, original_name, stored_name, note) VALUES (?, ?, ?, ?, ?, ?)',
      [c.id, sub ? sub.id : null, req.user.id, req.file.originalname, req.file.filename, note || null]);
    await L.log(req.user.id, `attached ${req.file.originalname} to ${g.name}, Chapter ${c.number}`);
    await L.notifyGroup(g.id, `${req.user.name} attached a marked file to Chapter ${c.number}.`, `/student/chapter/${c.number}`, null, 'adviser');
    req.flash('ok', 'The file was shared with the group.');
    res.redirect(back);
  }
);

router.post('/group/:id/chapter/:n/marked/:fid/delete', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return denied(res);
  const c = await chapterOf(g.id, req.params.n);
  const f = c && await db.get('SELECT * FROM adviser_files WHERE id = ? AND chapter_id = ?', [Number(req.params.fid), c.id]);
  if (f) {
    await db.run('DELETE FROM adviser_files WHERE id = ?', [f.id]);
    fs.rmSync(path.join(db.UPLOAD_DIR, path.basename(f.stored_name)), { force: true });
    req.flash('ok', 'The file was removed.');
  }
  res.redirect(`/adviser/group/${g.id}/chapter/${req.params.n}`);
});

// Approve, return for revision or reject. A comment is required unless the chapter is approved.
router.post('/group/:id/chapter/:n/review', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return denied(res);
  const c = await chapterOf(g.id, req.params.n);
  const back = `/adviser/group/${g.id}/chapter/${req.params.n}`;
  const decision = req.body.decision;
  const body = String(req.body.comment || '').trim().slice(0, 2000);
  if (!c || c.status !== 'submitted') { req.flash('error', 'Only a submitted chapter can be reviewed.'); return res.redirect(back); }
  if (!['approved', 'revision', 'rejected'].includes(decision)) { req.flash('error', 'Choose a decision.'); return res.redirect(back); }
  if (decision !== 'approved' && !body) { req.flash('error', 'Add a comment so the students know what to fix.'); return res.redirect(back); }
  await db.transaction(async () => {
    if (body) await db.run('INSERT INTO comments (chapter_id, author_id, body) VALUES (?, ?, ?)', [c.id, req.user.id, body]);
    await db.run('UPDATE chapters SET status = ? WHERE id = ?', [decision, c.id]);
  });
  const label = { approved: 'approved', revision: 'returned for revision', rejected: 'rejected' }[decision];
  await L.log(req.user.id, `${label} ${g.name}, Chapter ${c.number}`);
  await L.notifyGroup(g.id, `Chapter ${c.number} was ${label} by ${req.user.name}.`, `/student/chapter/${c.number}`, null, 'adviser');
  req.flash('ok', `Chapter ${c.number} marked ${L.STATUS[decision].label.toLowerCase()}.`);
  res.redirect(`/adviser/group/${g.id}`);
});

router.post('/group/:id/chapter/:n/comment', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return denied(res);
  const c = await chapterOf(g.id, req.params.n);
  const back = `/adviser/group/${g.id}/chapter/${req.params.n}`;
  const body = String(req.body.comment || '').trim().slice(0, 2000);
  if (!c || !body) { req.flash('error', 'Type a comment first.'); return res.redirect(back); }
  await db.run('INSERT INTO comments (chapter_id, author_id, body) VALUES (?, ?, ?)', [c.id, req.user.id, body]);
  await L.notifyGroup(g.id, `${req.user.name} commented on Chapter ${c.number}.`, `/student/chapter/${c.number}`, null, 'adviser');
  req.flash('ok', 'Comment added.');
  res.redirect(back);
});

router.post('/group/:id/chapter/:n/deadline', async (req, res) => {
  const g = await myGroup(req, req.params.id);
  if (!g) return denied(res);
  const c = await chapterOf(g.id, req.params.n);
  if (!c || !L.isDate(req.body.deadline)) { req.flash('error', 'Pick a valid date.'); return res.redirect(`/adviser/group/${g.id}`); }
  await db.run('UPDATE chapters SET deadline = ? WHERE id = ?', [req.body.deadline, c.id]);
  await L.log(req.user.id, `set ${g.name} Chapter ${c.number} deadline to ${L.fmtDate(req.body.deadline)}`);
  await L.notifyGroup(g.id, `New deadline for Chapter ${c.number}: ${L.fmtDate(req.body.deadline)}.`, `/student/chapter/${c.number}`, null, 'adviser');
  req.flash('ok', `Chapter ${c.number} deadline saved.`);
  res.redirect(`/adviser/group/${g.id}`);
});

router.post('/consultations/:id', async (req, res) => {
  const k = await db.get('SELECT * FROM consultations WHERE id = ? AND adviser_id = ?', [Number(req.params.id), req.user.id]);
  const status = req.body.status;
  // Answered from the details page, the adviser stays there.
  const to = ['/adviser', '/adviser/consultations'].includes(req.body.back) ? req.body.back : '/adviser';
  if (!k || !['Confirmed', 'Declined'].includes(status)) { req.flash('error', 'That request was not found.'); return res.redirect(to); }
  await db.run('UPDATE consultations SET status = ? WHERE id = ?', [status, k.id]);
  await L.notifyGroup(k.group_id, `Your consultation on ${L.fmtDate(k.date)} at ${k.slot} was ${status.toLowerCase()}.`, '/student', null, 'adviser');
  await L.log(req.user.id, `${status.toLowerCase()} a consultation`);
  req.flash('ok', `Consultation ${status.toLowerCase()}.`);
  res.redirect(to);
});

module.exports = router;
