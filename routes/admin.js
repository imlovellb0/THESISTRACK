const router = require('express').Router();
const bcrypt = require('bcryptjs');
const mailer = require('../mailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const L = require('../lib');
const { applyBulk, summary: bulkSummary } = require('../userbulk');

// Everything a coordinator sees or changes is limited to their own workspace (req.user.workspace_id).
const allGroups = async (wid) =>
  Promise.all(
    (await db.all('SELECT * FROM thesis_groups WHERE workspace_id = ? ORDER BY name', [wid])).map(async (g) => ({
      ...(await L.summarize(g)),
      lastRequest: (await L.requestsOf(g.id))[0] || null,
    }))
  );
const allUsers = (wid) => db.all('SELECT * FROM users WHERE workspace_id = ? ORDER BY role, name', [wid]);
const userIn = (wid, id) => db.get('SELECT * FROM users WHERE id = ? AND workspace_id = ?', [Number(id), wid]);
const groupIn = (wid, id) => db.get('SELECT * FROM thesis_groups WHERE id = ? AND workspace_id = ?', [Number(id), wid]);

router.get('/', async (req, res) => {
  const wid = req.user.workspace_id;
  const groups = await allGroups(wid);
  res.render('admin/overview', {
    title: 'Overview',
    joinLink: `${process.env.APP_URL || `${req.protocol}://${req.get('host')}`}/register?code=${res.locals.workspace ? res.locals.workspace.join_code : ''}`,
    groups,
    counts: {
      groups: groups.length,
      onTrack: groups.filter((g) => g.health === 'on track').length,
      delayed: groups.filter((g) => g.health === 'delayed').length,
      completed: groups.filter((g) => g.health === 'completed').length,
      users: (await db.get('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?', [wid])).n,
    },
    noAdviser: groups.filter((g) => !g.adviser_id).length,
    activity: await db.all('SELECT a.*, u.name FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.workspace_id = ? ORDER BY a.id DESC LIMIT 12', [wid]),
  });
});

// ---------- users ----------
router.get('/users', async (req, res) => {
  res.render('admin/users', { title: 'Users', users: await allUsers(req.user.workspace_id), form: {} });
});

router.post('/users', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const password = String(req.body.password || '');
  const role = req.body.role;
  const studentNo = role === 'student' ? String(req.body.student_no || '').trim().slice(0, 30) : '';
  const fail = async (msg) =>
    res.status(400).render('admin/users', { title: 'Users', users: await allUsers(req.user.workspace_id), form: { name, email, role, student_no: studentNo, course: req.body.course, year_level: req.body.year_level, section: req.body.section }, error: msg });
  const cls = role === 'student' ? L.readClass(req.body, true) : { value: {} };
  if (cls.error) return fail(cls.error);
  if (!name) return fail('Enter a name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
  if (role === 'adviser') return fail('Advisers join by invitation. Use the Advisers page.');
  if (!['student', 'panel'].includes(role)) return fail('Choose a role.');
  if (role !== 'panel' && password.length < 8) return fail('The starting password needs at least 8 characters.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return fail('That email is already registered.');
  if (studentNo && !/^[A-Za-z0-9][A-Za-z0-9\-\/]{2,29}$/.test(studentNo)) return fail('The student ID number may use letters, numbers and dashes only.');
  if (studentNo && (await db.get('SELECT 1 FROM users WHERE student_no = ?', [studentNo]))) return fail('That student ID number is already registered.');
  await db.run('INSERT INTO users (name, email, password_hash, role, student_no, course, year_level, section, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [name, email, await bcrypt.hash(role === 'panel' ? crypto.randomBytes(24).toString('hex') : password, 10), role, studentNo || null, cls.value.course || null, cls.value.year_level || null, cls.value.section || null, req.user.workspace_id]);
  await L.log(req.user.id, `added ${name} as ${L.ROLE_LABEL[role].toLowerCase()}`);
    // SEND EMAIL WITH LOGIN + STARTING PASSWORD
  try {
    console.log('[ADD USER] Sending email to:', email);
    await mailer.sendMail({
      to: email,
      subject: 'Your ThesisTrack Account',
          text: `Hello ${name},\n\nYour ThesisTrack account is ready.\n\nLogin here: https://thesistrack-ikda.onrender.com/login\nEmail: ${email}\nStarting Password: ${password}\nRole: ${role}\n\nPlease change your password after first login.`,
          html: `<div style="font-family:Arial;max-width:500px;margin:0 auto;padding:20px;"><h2>ThesisTrack</h2><p>Hello ${name},</p><p>Your account is ready.</p><p><b>Login:</b> <a href="https://thesistrack-ikda.onrender.com/login">https://thesistrack-ikda.onrender.com/login</a><br><b>Email:</b> ${email}<br><b>Starting Password:</b> ${password}<br><b>Role:</b> ${role}</p><p>Please change your password after first login.</p></div>`,
    });
    console.log('[ADD USER] Email sent to:', email);
  } catch (e) {
    console.log('[ADD USER] Email failed:', e.message);
  }
  req.flash('ok', role === 'panel' ? `${name} was added as a panel member.` : `${name} was added. Share the starting password with them privately.`);
  res.redirect('/admin/users');
});

// Several accounts at once: activate, deactivate or remove. Only this workspace's accounts can be reached.
router.post('/users/bulk', async (req, res) => {
  const action = String(req.body.action || '');
  const ids = [].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!['activate', 'deactivate', 'remove'].includes(action)) req.flash('error', 'Choose what to do with the selected accounts.');
  else if (!ids.length) req.flash('error', 'Tick at least one account first.');
  else {
    const users = await db.all('SELECT * FROM users WHERE workspace_id = ? AND id IN (?) ORDER BY name', [req.user.workspace_id, ids]);
    const result = await applyBulk(action, users, req.user);
    req.flash(result.done ? 'ok' : 'error', bulkSummary(action, result));
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle', async (req, res) => {
  const u = await userIn(req.user.workspace_id, req.params.id);
  if (!u) req.flash('error', 'User not found.');
  else if (u.id === req.user.id) req.flash('error', 'You cannot deactivate your own account.');
  else {
    await db.run('UPDATE users SET active = ? WHERE id = ?', [u.active ? 0 : 1, u.id]);
    await L.log(req.user.id, `${u.active ? 'deactivated' : 'activated'} ${u.name}`);
    req.flash('ok', `${u.name} is now ${u.active ? 'inactive' : 'active'}.`);
  }
  res.redirect('/admin/users');
});

// ---------- advisers: invitation with a one-time code ----------
const OTP_MINUTES = 60;
const newOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

async function sendInvite(invite, otp) {
  return mailer.send({
    to: invite.email,
    subject: 'Your ThesisTrack adviser invitation',
    text:
      `Hello ${invite.name},\n\nThe thesis coordinator invited you to join ThesisTrack as an adviser.\n\n` +
      `Your one-time code: ${otp}\nIt works for ${OTP_MINUTES} minutes.\n\n` +
      `To finish, open the adviser registration page, enter this email address and the code, then choose a password.\n` +
      `If you did not expect this, ignore this email.\n`,
  });
}

const advisersPage = async (req, res, extra = {}) => {
  const invites = await db.all('SELECT *, (expires_at < NOW()) AS expired FROM adviser_invites WHERE workspace_id = ? ORDER BY id DESC', [req.user.workspace_id]);
  return res.render('admin/advisers', { title: 'Advisers', invites, form: {}, ttl: OTP_MINUTES, mailReady: mailer.configured(), ...extra });
};

router.get('/advisers', (req, res) => advisersPage(req, res));

router.post('/advisers', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const fail = (msg) => advisersPage(req, res.status(400), { error: msg, form: { name, email } });
  if (!name) return fail('Enter the adviser\u2019s name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return fail('That email already has an account.');
  const otp = newOtp();
  await db.transaction(async () => {
    await db.run("UPDATE adviser_invites SET status = 'Cancelled' WHERE email = ? AND status = 'Invited'", [email]);
    await db.run(
      `INSERT INTO adviser_invites (name, email, otp_hash, expires_at, invited_by, workspace_id)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ${OTP_MINUTES} MINUTE), ?, ?)`,
      [name, email, await bcrypt.hash(otp, 10), req.user.id, req.user.workspace_id]
    );
  });
  await L.log(req.user.id, `invited ${name} to join as an adviser`);
  try {
    const r = await sendInvite({ name, email }, otp);
    req.flash('ok', r.sent ? `Invitation sent to ${email}.` : `Invitation saved. Email is not set up, so the code is in outbox/mail.log.`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'The invitation was saved but the email could not be sent. Check the email settings, then use "Send a new code".');
  }
  res.redirect('/admin/advisers');
});

router.post('/advisers/:id/resend', async (req, res) => {
  const inv = await db.get("SELECT * FROM adviser_invites WHERE id = ? AND status = 'Invited' AND workspace_id = ?", [Number(req.params.id), req.user.workspace_id]);
  if (!inv) { req.flash('error', 'That invitation is no longer open.'); return res.redirect('/admin/advisers'); }
  const otp = newOtp();
  await db.run(
    `UPDATE adviser_invites SET otp_hash = ?, attempts = 0, expires_at = DATE_ADD(NOW(), INTERVAL ${OTP_MINUTES} MINUTE) WHERE id = ?`,
    [await bcrypt.hash(otp, 10), inv.id]
  );
  try {
    const r = await sendInvite(inv, otp);
    req.flash('ok', r.sent ? `A new code was sent to ${inv.email}.` : 'A new code was saved in outbox/mail.log.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'The email could not be sent. Check the email settings and try again.');
  }
  res.redirect('/admin/advisers');
});

router.post('/advisers/:id/cancel', async (req, res) => {
  await db.run("UPDATE adviser_invites SET status = 'Cancelled' WHERE id = ? AND status = 'Invited' AND workspace_id = ?", [Number(req.params.id), req.user.workspace_id]);
  req.flash('ok', 'Invitation cancelled. The code no longer works.');
  res.redirect('/admin/advisers');
});

// ---------- panel members: invited with a one-time code, then they sign in to see the groups on their panel ----------
const panelPage = async (req, res, extra = {}) => {
  const members = await db.all("SELECT * FROM users WHERE role = 'panel' AND workspace_id = ? ORDER BY name", [req.user.workspace_id]);
  for (const m of members) {
    m.groups = (await db.all('SELECT g.name FROM thesis_groups g JOIN group_panelists p ON p.group_id = g.id WHERE p.panel_id = ? ORDER BY g.name', [m.id])).map((g) => g.name);
  }
  const invites = await db.all('SELECT *, (expires_at < NOW()) AS expired FROM panel_invites WHERE workspace_id = ? ORDER BY id DESC', [req.user.workspace_id]);
  return res.render('admin/panel', { title: 'Panel members', members, invites, form: {}, ttl: OTP_MINUTES, mailReady: mailer.configured(), ...extra });
};

function sendPanelInvite(invite, otp) {
  return mailer.send({
    to: invite.email,
    subject: 'Your ThesisTrack panel invitation',
    text:
      `Hello ${invite.name},\n\nThe thesis coordinator invited you to join ThesisTrack as a panel member.\n\n` +
      `Your one-time code: ${otp}\nIt works for ${OTP_MINUTES} minutes.\n\n` +
      `To finish, open the panel registration page, enter this email address and the code, then choose a password.\n` +
      `If you did not expect this, ignore this email.\n`,
  });
}

router.post('/panel/invite', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const fail = (msg) => panelPage(req, res.status(400), { error: msg, form: { name, email } });
  if (!name) return fail('Enter the panel member’s name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
  // A panel member the coordinator already recorded can be invited, so they keep their group assignments when they register.
  const existing = await db.get('SELECT role, workspace_id FROM users WHERE email = ?', [email]);
  if (existing && !(existing.role === 'panel' && existing.workspace_id === req.user.workspace_id)) return fail('That email already has an account.');
  const otp = newOtp();
  await db.transaction(async () => {
    await db.run("UPDATE panel_invites SET status = 'Cancelled' WHERE email = ? AND status = 'Invited'", [email]);
    await db.run(
      `INSERT INTO panel_invites (name, email, otp_hash, expires_at, invited_by, workspace_id)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ${OTP_MINUTES} MINUTE), ?, ?)`,
      [name, email, await bcrypt.hash(otp, 10), req.user.id, req.user.workspace_id]
    );
  });
  await L.log(req.user.id, `invited ${name} to join as a panel member`);
  try {
    const r = await sendPanelInvite({ name, email }, otp);
    req.flash('ok', r.sent ? `Invitation sent to ${email}.` : 'Invitation saved. Email is not set up, so the code is in outbox/mail.log.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'The invitation was saved but the email could not be sent. Check the email settings, then use "Send a new code".');
  }
  res.redirect('/admin/panel');
});

router.post('/panel/invite/:id/resend', async (req, res) => {
  const inv = await db.get("SELECT * FROM panel_invites WHERE id = ? AND status = 'Invited' AND workspace_id = ?", [Number(req.params.id), req.user.workspace_id]);
  if (!inv) { req.flash('error', 'That invitation is no longer open.'); return res.redirect('/admin/panel'); }
  const otp = newOtp();
  await db.run(
    `UPDATE panel_invites SET otp_hash = ?, attempts = 0, expires_at = DATE_ADD(NOW(), INTERVAL ${OTP_MINUTES} MINUTE) WHERE id = ?`,
    [await bcrypt.hash(otp, 10), inv.id]
  );
  try {
    const r = await sendPanelInvite(inv, otp);
    req.flash('ok', r.sent ? `A new code was sent to ${inv.email}.` : 'A new code was saved in outbox/mail.log.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'The email could not be sent. Check the email settings and try again.');
  }
  res.redirect('/admin/panel');
});

router.post('/panel/invite/:id/cancel', async (req, res) => {
  await db.run("UPDATE panel_invites SET status = 'Cancelled' WHERE id = ? AND status = 'Invited' AND workspace_id = ?", [Number(req.params.id), req.user.workspace_id]);
  req.flash('ok', 'Invitation cancelled. The code no longer works.');
  res.redirect('/admin/panel');
});

const cleanPerson = (body) => ({
  name: String(body.name || '').trim().slice(0, 255),
  email: String(body.email || '').trim().toLowerCase().slice(0, 190),
});
const personError = async ({ name, email }, exceptId = 0) => {
  if (!name) return 'Enter a name.';
  if (!/^\S+@\S+\.\S+$/.test(email)) return 'Enter a valid email address.';
  if (await db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', [email, exceptId])) return 'That email is already used by another account.';
  return null;
};
const panelMember = (req, id) => db.get("SELECT * FROM users WHERE id = ? AND role = 'panel' AND workspace_id = ?", [Number(id), req.user.workspace_id]);

router.get('/panel', (req, res) => panelPage(req, res));

router.post('/panel/:id', async (req, res) => {
  const m = await panelMember(req, req.params.id);
  if (!m) { req.flash('error', 'Panel member not found.'); return res.redirect('/admin/panel'); }
  const p = cleanPerson(req.body);
  const err = await personError(p, m.id);
  if (err) { req.flash('error', `${m.name}: ${err}`); return res.redirect('/admin/panel'); }
  await db.run('UPDATE users SET name = ?, email = ? WHERE id = ?', [p.name, p.email, m.id]);
  await L.log(req.user.id, `edited panel member ${p.name}`);
  req.flash('ok', `${p.name} was updated.`);
  res.redirect('/admin/panel');
});

router.post('/panel/:id/toggle', async (req, res) => {
  const m = await panelMember(req, req.params.id);
  if (!m) req.flash('error', 'Panel member not found.');
  else {
    await db.run('UPDATE users SET active = ? WHERE id = ?', [m.active ? 0 : 1, m.id]);
    await L.log(req.user.id, `${m.active ? 'deactivated' : 'activated'} panel member ${m.name}`);
    req.flash('ok', `${m.name} is now ${m.active ? 'inactive' : 'active'}.`);
  }
  res.redirect('/admin/panel');
});

router.post('/panel/:id/delete', async (req, res) => {
  const m = await panelMember(req, req.params.id);
  if (!m) req.flash('error', 'Panel member not found.');
  else {
    await db.transaction(async () => {
      await db.run('DELETE FROM group_panelists WHERE panel_id = ?', [m.id]);
      await db.run('DELETE FROM users WHERE id = ?', [m.id]);
    });
    await L.log(req.user.id, `removed panel member ${m.name}`);
    req.flash('ok', `${m.name} was removed from the system and from every panel.`);
  }
  res.redirect('/admin/panel');
});

// ---------- panel grades: the rubric, each group's submitted sheets, and returning a sheet for correction ----------
const gradeSummary = async (g) => {
  const sheets = await db.all(
    `SELECT s.*, u.name AS panel_name FROM panel_grades s JOIN users u ON u.id = s.panel_id WHERE s.group_id = ? ORDER BY u.name`, [g.id]);
  const assigned = await L.panelOf(g.id);
  const submitted = sheets.filter((s) => s.status === 'Submitted');
  const average = submitted.length ? submitted.reduce((a, s) => a + Number(s.total), 0) / submitted.length : null;
  // Panelists who are on the panel but have not started a sheet.
  const missing = assigned.filter((p) => !sheets.some((s) => s.panel_id === p.id));
  return { sheets, assigned, submitted, average, missing };
};

router.get('/grades', async (req, res) => {
  const wid = req.user.workspace_id;
  const groups = [];
  for (const g of await db.all('SELECT * FROM thesis_groups WHERE workspace_id = ? ORDER BY name', [wid])) groups.push({ ...g, ...(await gradeSummary(g)) });
  res.render('admin/grades', { title: 'Panel grades', groups, rubric: await L.rubricOf(wid) });
});

router.post('/grades/rubric', async (req, res) => {
  const titles = [].concat(req.body.title || []);
  const maxes = [].concat(req.body.max || []);
  const list = [];
  for (let i = 0; i < titles.length; i++) {
    const title = String(titles[i] || '').trim().slice(0, 120);
    if (!title) continue;
    const max = Number(maxes[i]);
    if (!Number.isInteger(max) || max < 1 || max > 100) { req.flash('error', `${title}: the maximum must be a whole number from 1 to 100.`); return res.redirect('/admin/grades'); }
    list.push({ title, max });
  }
  if (!list.length || list.length > 8) { req.flash('error', 'Use between 1 and 8 criteria.'); return res.redirect('/admin/grades'); }
  const sum = list.reduce((a, c) => a + c.max, 0);
  if (sum !== 100) { req.flash('error', `The maximums add up to ${sum}. They must add up to 100.`); return res.redirect('/admin/grades'); }
  await L.saveRubric(req.user.workspace_id, list);
  await L.log(req.user.id, 'changed the panel grading rubric');
  req.flash('ok', 'Rubric saved. Sheets a panelist has already started keep the criteria they began with.');
  res.redirect('/admin/grades');
});

router.get('/grades/:gid', async (req, res) => {
  const g = await groupIn(req.user.workspace_id, req.params.gid);
  if (!g) return res.status(404).render('error', { title: 'Not found', message: 'That group does not exist.' });
  const sum = await gradeSummary(g);
  for (const s of sum.sheets) s.scores = await L.gradeScores(s.id);
  res.render('admin/grade', { title: `${g.name} grades`, g, ...sum, ...(await releaseState(g, sum)) });
});

// What the release box needs: is every assigned panelist done, which outcome the majority chose, and the history.
async function releaseState(g, sum) {
  const done = (p) => sum.sheets.some((s) => s.panel_id === p.id && s.status === 'Submitted');
  const waiting = sum.assigned.filter((p) => !done(p));
  const counts = {};
  for (const s of sum.submitted) if (s.outcome) counts[s.outcome] = (counts[s.outcome] || 0) + 1;
  const top = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((k) => counts[k] === top);
  return {
    waiting, ready: sum.assigned.length > 0 && !waiting.length,
    suggested: leaders.length === 1 ? leaders[0] : null, counts,
    history: await db.all('SELECT h.*, u.name AS by_name FROM result_history h JOIN users u ON u.id = h.released_by WHERE h.group_id = ? ORDER BY h.id DESC', [g.id]),
  };
}

// Release the result to the group (first time), or correct a result already released. Every release is written to the history and the activity log.
router.post('/grades/:gid/release', async (req, res) => {
  const g = await groupIn(req.user.workspace_id, req.params.gid);
  if (!g) return res.redirect('/admin/grades');
  const back = `/admin/grades/${g.id}`;
  const stop = (msg) => { req.flash('error', msg); return res.redirect(back); };
  const sum = await gradeSummary(g);
  const state = await releaseState(g, sum);
  const outcome = String(req.body.final_outcome || '');
  const note = String(req.body.note || '').trim().slice(0, 2000);
  const update = !!g.result_released_at;
  if (!state.ready) return stop(`Wait for every panel member to submit: ${state.waiting.map((p) => p.name).join(', ') || 'no panel members are assigned'}.`);
  if (!L.OUTCOMES.includes(outcome)) return stop('Choose the final outcome.');
  if (update && !note) return stop('Write a note explaining the change. The group sees it, and it is kept in the history.');
  const average = sum.average === null ? null : Math.round(sum.average * 100) / 100;
  await db.transaction(async () => {
    await db.run('UPDATE thesis_groups SET result_outcome = ?, result_note = ?, result_average = ?, result_released_at = NOW() WHERE id = ?', [outcome, note || null, average, g.id]);
    await db.run('INSERT INTO result_history (group_id, released_by, kind, outcome, previous_outcome, note, average) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [g.id, req.user.id, update ? 'update' : 'release', outcome, update ? g.result_outcome : null, note || null, average]);
  });
  await L.log(req.user.id, update
    ? `corrected the released result of ${g.name} from ${g.result_outcome} to ${outcome}`
    : `released the defense result of ${g.name}: ${outcome}, average ${average === null ? 'none' : average.toFixed(2)}`);
  const msg = update ? `The defense result of ${g.name} was updated: ${outcome}.` : `The defense result of ${g.name} is out: ${outcome}.`;
  await L.notifyGroup(g.id, msg, '/student#result', null, 'coordinator');
  if (g.adviser_id) await L.notify(g.adviser_id, msg, `/adviser/group/${g.id}#panel-results`, 'coordinator');
  req.flash('ok', update ? 'The result was updated and the group was notified.' : 'The result was released and the group was notified.');
  res.redirect(back);
});

router.post('/grades/:gid/:sheetId/return', async (req, res) => {
  const g = await groupIn(req.user.workspace_id, req.params.gid);
  const s = g && await db.get("SELECT * FROM panel_grades WHERE id = ? AND group_id = ? AND status = 'Submitted'", [Number(req.params.sheetId), g.id]);
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (g && g.result_released_at) req.flash('error', 'The result was already released, so sheets are locked. Correct the released result instead.');
  else if (!s) req.flash('error', 'That sheet is not submitted, so there is nothing to return.');
  else if (!note) req.flash('error', 'Write a note so the panelist knows what to correct.');
  else {
    await db.run("UPDATE panel_grades SET status = 'Returned', return_note = ? WHERE id = ?", [note, s.id]);
    await L.notify(s.panel_id, `The coordinator returned your grade for ${g.name}: ${note}`, `/panel/group/${g.id}#grade`, 'coordinator');
    await L.log(req.user.id, `returned a panel grade for ${g.name}`);
    req.flash('ok', 'Sheet returned. The panelist was notified and can edit and submit it again.');
  }
  res.redirect(`/admin/grades/${req.params.gid}`);
});

// ---------- groups: adviser, panel and defense schedule ----------
// The overview tiles link here with ?health=on-track, delayed or completed to show only those groups.
const HEALTH = { 'on-track': 'on track', delayed: 'delayed', completed: 'completed' };
router.get('/groups', async (req, res) => {
  const groups = await allGroups(req.user.workspace_id);
  const filter = HEALTH[req.query.health] ? req.query.health : '';
  const panelists = await db.all("SELECT id, name FROM users WHERE role = 'panel' AND active = 1 AND workspace_id = ? ORDER BY name", [req.user.workspace_id]);
  res.render('admin/groups', { title: 'Groups', groups, panelists, shown: filter ? groups.filter((g) => g.health === HEALTH[filter]) : groups, filter });
});

// Set one chapter's deadline for the groups the coordinator ticks. Registered before /groups/:id so "deadline" is not read as an id.
router.post('/groups/deadline', async (req, res) => {
  const wid = req.user.workspace_id;
  const n = Number(req.body.chapter);
  const deadline = String(req.body.deadline || '');
  const ids = [...new Set([].concat(req.body.groups || []).map(Number))].filter(Number.isInteger);
  const fail = (msg) => { req.flash('error', msg); res.redirect('/admin/groups'); };
  if (!Number.isInteger(n) || n < 1 || n > res.locals.chNames.length) return fail('Choose a chapter.');
  if (!L.isDate(deadline)) return fail('Pick a valid deadline date.');
  if (!ids.length) return fail('Tick at least one group.');
  let done = 0;
  for (const id of ids) {
    const g = await groupIn(wid, id);
    if (!g) continue;
    const c = await db.get('SELECT * FROM chapters WHERE group_id = ? AND number = ?', [g.id, n]);
    if (!c) continue;
    await db.run('UPDATE chapters SET deadline = ? WHERE id = ?', [deadline, c.id]);
    await L.notifyGroup(g.id, `New deadline for Chapter ${n}: ${L.fmtDate(deadline)}.`, `/student/chapter/${n}`, null, 'coordinator');
    done++;
  }
  if (done) await L.log(req.user.id, `set the Chapter ${n} deadline to ${L.fmtDate(deadline)} for ${done} group${done === 1 ? '' : 's'}`);
  req.flash('ok', done ? `Chapter ${n} deadline set to ${L.fmtDate(deadline)} for ${done} group${done === 1 ? '' : 's'}.` : 'No matching groups were found.');
  res.redirect('/admin/groups');
});

// Set the defense date for the groups the coordinator ticks. Time and room are applied to all of them when filled in,
// otherwise each group keeps its own. A group still needs a time, a room and two panel members, or it is skipped and named.
router.post('/groups/defense', async (req, res) => {
  const wid = req.user.workspace_id;
  const date = String(req.body.defense_date || '');
  const time = String(req.body.defense_time || '');
  const room = String(req.body.room || '').trim().slice(0, 60);
  const ids = [...new Set([].concat(req.body.groups || []).map(Number))].filter(Number.isInteger);
  const fail = (msg) => { req.flash('error', msg); res.redirect('/admin/groups'); };
  if (!L.isDate(date)) return fail('Pick a valid defense date.');
  if (date < L.today()) return fail('The defense date cannot be in the past.');
  if (time && !L.isTime(time)) return fail('Enter a valid defense time.');
  if (!ids.length) return fail('Tick at least one group.');
  // Panel members picked here replace the panel of every ticked group. Pick none to keep each group's own panel.
  const panel = [...new Set([].concat(req.body.panel || []).map(Number))].filter(Number.isInteger);
  if (panel.length) {
    if (panel.length < 2) return fail('Choose at least two panel members, or none to keep each panel as it is.');
    for (const p of panel) if (!(await db.get("SELECT 1 FROM users WHERE id = ? AND role = 'panel' AND active = 1 AND workspace_id = ?", [p, wid]))) return fail('Choose panel members from the list.');
  }
  const done = [], skipped = [];
  for (const id of ids) {
    const g = await groupIn(wid, id);
    if (!g) continue;
    if (!g.defense_date && !g.endorsed_at) { skipped.push(`${g.name} (needs the adviser's endorsement)`); continue; }
    const t = time || g.defense_time, r = room || g.room;
    if (!t || !r) { skipped.push(`${g.name} (needs a time and room)`); continue; }
    if (!panel.length && (await L.panelOf(g.id)).length < 2) { skipped.push(`${g.name} (needs two panel members)`); continue; }
    await db.transaction(async () => {
      await db.run('UPDATE thesis_groups SET defense_date = ?, defense_time = ?, room = ? WHERE id = ?', [date, t, r, g.id]);
      if (panel.length) {
        await db.run('DELETE FROM group_panelists WHERE group_id = ?', [g.id]);
        for (const p of panel) await db.run('INSERT INTO group_panelists (group_id, panel_id) VALUES (?, ?)', [g.id, p]);
      }
    });
    if (date !== g.defense_date || t !== g.defense_time || r !== g.room) {
      await L.notifyGroup(g.id, `Defense for ${g.name}: ${L.fmtDate(date)} at ${t}, room ${r}.`, '/student', null, 'coordinator');
    }
    done.push(g.name);
  }
  if (done.length) await L.log(req.user.id, `set the defense date to ${L.fmtDate(date)} for ${done.length} group${done.length === 1 ? '' : 's'}`);
  if (skipped.length) req.flash('error', `${done.length ? `Saved ${done.length}. ` : ''}Skipped: ${skipped.join('; ')}.`);
  else req.flash('ok', `Defense date set to ${L.fmtDate(date)} for ${done.length} group${done.length === 1 ? '' : 's'}.`);
  res.redirect('/admin/groups');
});

async function groupForm(wid, g, extra = {}) {
  const pending = await L.pendingRequestOf(g.id);
  return {
    title: g.name, g: await L.summarize(g), members: await L.membersOf(g.id),
    advisers: await db.all(
      `SELECT u.id, u.name, (SELECT COUNT(*) FROM thesis_groups x WHERE x.adviser_id = u.id) AS load_count,
        (SELECT COUNT(*) FROM adviser_requests r WHERE r.adviser_id = u.id AND r.status = 'Pending') AS waiting
       FROM users u WHERE u.role = 'adviser' AND u.active = 1 AND u.workspace_id = ? ORDER BY u.name`,
      [wid]
    ),
    declined: (await db.all("SELECT adviser_id FROM adviser_requests WHERE group_id = ? AND status = 'Declined'", [g.id])).map((r) => r.adviser_id),
    panelists: await db.all(
      "SELECT id, name, active FROM users WHERE role = 'panel' AND workspace_id = ? AND (active = 1 OR id IN (SELECT panel_id FROM group_panelists WHERE group_id = ?)) ORDER BY name",
      [wid, g.id]
    ),
    chosen: (await L.panelOf(g.id)).map((p) => p.id),
    requests: await L.requestsOf(g.id),
    pending,
    ...extra,
  };
}

router.get('/groups/:id', async (req, res) => {
  const g = await groupIn(req.user.workspace_id, req.params.id);
  if (!g) return res.status(404).render('error', { title: 'Not found', message: 'That group does not exist.' });
  res.render('admin/group', await groupForm(req.user.workspace_id, g));
});

router.post('/groups/:id', async (req, res) => {
  const wid = req.user.workspace_id;
  const g = await groupIn(wid, req.params.id);
  if (!g) return res.redirect('/admin/groups');
  const adviserId = req.body.adviser_id ? Number(req.body.adviser_id) : null;
  const panel = [...new Set([].concat(req.body.panel || []).map(Number))];
  const date = String(req.body.defense_date || '');
  const time = String(req.body.defense_time || '');
  const room = String(req.body.room || '').trim().slice(0, 60);
  const fail = async (msg) => res.status(400).render('admin/group', await groupForm(wid, g, { error: msg, chosen: panel }));
  const cls = L.readClass(req.body, true);
  if (cls.error) return fail(cls.error);

  if (adviserId && !(await db.get("SELECT 1 FROM users WHERE id = ? AND role = 'adviser' AND active = 1 AND workspace_id = ?", [adviserId, wid]))) return fail('Pick an active adviser.');
  for (const p of panel) if (!(await db.get("SELECT 1 FROM users WHERE id = ? AND role = 'panel' AND workspace_id = ? AND (active = 1 OR id IN (SELECT panel_id FROM group_panelists WHERE group_id = ?))", [p, wid, g.id]))) return fail('Choose panel members from the list.');
  if (date && !g.defense_date && !g.endorsed_at) return fail('The adviser must endorse the group for the defense before you can set a defense date.');
  if (date) {
    if (!L.isDate(date)) return fail('Enter a valid defense date.');
    if (date < L.today() && date !== g.defense_date) return fail('The defense date cannot be in the past.');
    if (!L.isTime(time)) return fail('Enter the defense time.');
    if (!room) return fail('Enter the defense room.');
    if (panel.length < 2) return fail('Choose at least two panel members for a scheduled defense.');
  }

  // An adviser is only a request until they accept it. The group keeps its current adviser (if any) meanwhile.
  const pending = await L.pendingRequestOf(g.id);
  const effective = pending ? pending.adviser_id : g.adviser_id;
  const adviserChanged = adviserId !== effective;
  const newRequest = adviserChanged && adviserId && adviserId !== g.adviser_id;

  await db.transaction(async () => {
    await db.run('UPDATE thesis_groups SET defense_date = ?, defense_time = ?, room = ?, course = ?, year_level = ?, section = ? WHERE id = ?',
      [date || null, date ? time : null, date ? room : null, cls.value.course, cls.value.year_level, cls.value.section, g.id]);
    await db.run('DELETE FROM group_panelists WHERE group_id = ?', [g.id]);
    for (const p of panel) await db.run('INSERT INTO group_panelists (group_id, panel_id) VALUES (?, ?)', [g.id, p]);
    if (adviserChanged) {
      await db.run("UPDATE adviser_requests SET status = 'Cancelled', decided_at = NOW() WHERE group_id = ? AND status = 'Pending'", [g.id]);
      if (!adviserId) await db.run('UPDATE thesis_groups SET adviser_id = NULL WHERE id = ?', [g.id]);
      if (newRequest) await db.run('INSERT INTO adviser_requests (group_id, adviser_id) VALUES (?, ?)', [g.id, adviserId]);
    }
  });

  if (newRequest) {
    await L.notify(adviserId, `${g.name} asks you to be their adviser. Accept or decline.`, '/adviser', 'coordinator');
  }
  if (date && (date !== g.defense_date || time !== g.defense_time || room !== g.room)) {
    const msg = `Defense for ${g.name}: ${L.fmtDate(date)} at ${time}, room ${room}.`;
    await L.notifyGroup(g.id, msg, '/student', null, 'coordinator');
  }
  await L.log(req.user.id, `updated ${g.name}${newRequest ? `, asked ${await L.userName(adviserId)} to advise` : ''}${date ? ' and scheduled the defense' : ''}`);
  req.flash('ok', newRequest ? `${g.name} saved. ${await L.userName(adviserId)} must accept before they become the adviser.` : `${g.name} saved.`);
  res.redirect(`/admin/groups/${g.id}`);
});

// The coordinator can set a chapter's status (approved or disapproved) and its deadline for any group in the workspace.
router.post('/groups/:id/chapter/:n', async (req, res) => {
  const g = await groupIn(req.user.workspace_id, req.params.id);
  if (!g) return res.redirect('/admin/groups');
  const back = `/admin/groups/${g.id}#chapters`;
  const c = await db.get('SELECT * FROM chapters WHERE group_id = ? AND number = ?', [g.id, Number(req.params.n)]);
  if (!c) { req.flash('error', 'That chapter does not exist.'); return res.redirect(back); }
  const status = String(req.body.status || '');
  const deadline = String(req.body.deadline || '');
  if (status !== c.status && !['approved', 'rejected'].includes(status)) { req.flash('error', 'Choose Approved or Disapproved.'); return res.redirect(back); }
  if (deadline && !L.isDate(deadline)) { req.flash('error', 'Pick a valid date.'); return res.redirect(back); }
  const newDeadline = deadline || null;
  const oldDeadline = c.deadline ? String(c.deadline).slice(0, 10) : null;
  const changes = [];
  if (status !== c.status) changes.push(`marked ${g.name} Chapter ${c.number} ${L.STATUS[status].label.toLowerCase()}`);
  if (newDeadline !== oldDeadline) changes.push(newDeadline ? `set ${g.name} Chapter ${c.number} deadline to ${L.fmtDate(newDeadline)}` : `cleared ${g.name} Chapter ${c.number} deadline`);
  if (!changes.length) { req.flash('ok', 'Nothing to change.'); return res.redirect(back); }
  await db.run('UPDATE chapters SET status = ?, deadline = ? WHERE id = ?', [status, newDeadline, c.id]);
  for (const ch of changes) await L.log(req.user.id, ch);
  if (status !== 'approved' && g.endorsed_at) {
    await db.run('UPDATE thesis_groups SET endorsed_at = NULL, endorsed_by = NULL WHERE id = ?', [g.id]);
    await L.log(req.user.id, `${g.name} lost its defense endorsement because Chapter ${c.number} is no longer approved`);
    if (g.adviser_id) await L.notify(g.adviser_id, `${g.name} lost its defense endorsement because Chapter ${c.number} is no longer approved. Endorse again when all chapters are approved.`, `/adviser/group/${g.id}`, 'coordinator');
  }
  if (status !== c.status) await L.notifyGroup(g.id, `Chapter ${c.number} was marked ${L.STATUS[status].label.toLowerCase()} by the coordinator.`, `/student/chapter/${c.number}`, null, 'coordinator');
  if (newDeadline && newDeadline !== oldDeadline) await L.notifyGroup(g.id, `New deadline for Chapter ${c.number}: ${L.fmtDate(newDeadline)}.`, `/student/chapter/${c.number}`, null, 'coordinator');
  req.flash('ok', `Chapter ${c.number} saved.`);
  res.redirect(back);
});

// ---------- announcements ----------
router.get('/announcements', async (req, res) => {
  res.render('admin/announcements', {
    title: 'Announcements', form: {},
    items: await db.all('SELECT * FROM announcements WHERE workspace_id = ? ORDER BY id DESC', [req.user.workspace_id]),
  });
});

router.post('/announcements', async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!title || !body) {
    return res.status(400).render('admin/announcements', {
      title: 'Announcements', form: { title, body }, error: 'Enter a title and a message.',
      items: await db.all('SELECT * FROM announcements WHERE workspace_id = ? ORDER BY id DESC', [req.user.workspace_id]),
    });
  }
  await db.transaction(async () => {
    const info = await db.run('INSERT INTO announcements (title, body, posted_by, workspace_id) VALUES (?, ?, ?, ?)', [title, body, req.user.id, req.user.workspace_id]);
    for (const u of await db.all('SELECT id FROM users WHERE active = 1 AND id != ? AND workspace_id = ?', [req.user.id, req.user.workspace_id])) await L.notify(u.id, `New announcement: ${title}`, `/announcements/${info.lastInsertRowid}`, 'coordinator');
  });
  await L.log(req.user.id, 'posted an announcement');
  req.flash('ok', 'Announcement posted. Everyone was notified.');
  res.redirect('/admin/announcements');
});

// ---------- reports ----------
// ---------- contents: the coordinator names, adds and removes the chapters every group in the workspace writes ----------
const MAX_CHAPTERS = 12;
const outlineLines = (v) => String(v || '').split('\n').map((l) => l.trim().slice(0, 200)).filter(Boolean);

router.get('/contents', async (req, res) => {
  const contents = await L.contentsOf(req.user.workspace_id);
  res.render('admin/contents', { title: 'Contents', rows: contents.map((c, i) => ({ orig: i + 1, title: c.title, items: c.items })), max: MAX_CHAPTERS });
});

router.post('/contents', async (req, res) => {
  const wid = req.user.workspace_id;
  const current = await L.contentsOf(wid);
  const indexes = [...new Set(Object.keys(req.body).map((k) => /^title_(\d+)$/.exec(k)).filter(Boolean).map((m) => Number(m[1])))].sort((a, b) => a - b);
  const rows = indexes.map((n) => ({
    orig: Number(req.body[`orig_${n}`]) || null,
    title: String(req.body[`title_${n}`] || '').trim().slice(0, 120),
    items: outlineLines(req.body[`items_${n}`]).slice(0, 12),
    remove: req.body[`remove_${n}`] === 'on',
  }));
  const again = (error) => res.status(400).render('admin/contents', { title: 'Contents', rows, max: MAX_CHAPTERS, error });

  const kept = rows.filter((r) => !r.remove);
  const origs = kept.map((r) => r.orig).filter(Boolean);
  if (!kept.length) return again('Keep at least one chapter.');
  if (kept.length > MAX_CHAPTERS) return again(`A thesis can have up to ${MAX_CHAPTERS} chapters.`);
  if (origs.some((o) => !Number.isInteger(o) || o < 1 || o > current.length) || new Set(origs).size !== origs.length) return again('Something went wrong with the list. Reload the page and try again.');
  const blank = kept.findIndex((r) => !r.title);
  if (blank >= 0) return again(`Give chapter ${blank + 1} a title.`);

  const removed = current.map((c, i) => i + 1).filter((n) => !origs.includes(n));
  if (removed.length && req.body.confirm !== 'on') return again(`Tick the box to confirm. Removing ${removed.map((n) => `"${current[n - 1].title}"`).join(', ')} deletes it, with every upload, comment and status, for all groups.`);

  const groups = (await db.all('SELECT id FROM thesis_groups WHERE workspace_id = ?', [wid])).map((g) => g.id);
  const marks = groups.map(() => '?').join(',');
  const files = [];
  await db.transaction(async () => {
    if (groups.length) {
      if (removed.length) {
        const rm = removed.map(() => '?').join(',');
        for (const f of await db.all(`SELECT s.stored_name FROM submissions s JOIN chapters c ON c.id = s.chapter_id WHERE c.group_id IN (${marks}) AND c.number IN (${rm})`, [...groups, ...removed])) files.push(f.stored_name);
        await db.run(`DELETE FROM chapters WHERE group_id IN (${marks}) AND number IN (${rm})`, [...groups, ...removed]);
      }
      // Renumber in two steps so no two chapters ever share a number.
      await db.run(`UPDATE chapters SET number = number + 1000 WHERE group_id IN (${marks})`, groups);
      for (const [pos, r] of kept.entries()) {
        if (r.orig) await db.run(`UPDATE chapters SET number = ? WHERE number = ? AND group_id IN (${marks})`, [pos + 1, r.orig + 1000, ...groups]);
        else for (const gid of groups) await db.run('INSERT INTO chapters (group_id, number) VALUES (?, ?)', [gid, pos + 1]);
      }
    }
    await L.saveContents(wid, kept.map((r) => ({ title: r.title, items: r.items })));
  });
  for (const f of files) fs.rmSync(path.join(db.UPLOAD_DIR, path.basename(f)), { force: true });

  const added = kept.filter((r) => !r.orig).length;
  const summary = [added && `added ${added}`, removed.length && `removed ${removed.length}`].filter(Boolean).join(' and ');
  await L.log(req.user.id, `edited the contents${summary ? ` (${summary} chapter${added + removed.length === 1 ? '' : 's'})` : ''}`);
  if (added || removed.length) for (const gid of groups) await L.notifyGroup(gid, 'The coordinator changed the thesis chapters. Check your chapter list.', '/student', null, 'coordinator');
  req.flash('ok', `Contents saved${added ? `. ${added} new chapter${added === 1 ? '' : 's'} added to every group, with no deadline yet` : ''}.`);
  res.redirect('/admin/contents');
});

router.get('/reports', async (req, res) => res.render('admin/reports', { title: 'Reports', groups: await allGroups(req.user.workspace_id) }));

// Spreadsheet programs run text that starts with = + - @ as a formula, so those cells get a leading apostrophe.
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/reports.csv', async (req, res) => {
  const rows = [['Group', 'Title', 'Members', 'Adviser', 'Chapters approved', 'Pending review', 'Status', 'Defense date', 'Room']];
  for (const g of await allGroups(req.user.workspace_id)) {
    rows.push([
      g.name, g.title, (await L.membersOf(g.id)).map((m) => m.name).join('; '), g.adviser_name || '',
      `${g.approved}/${g.chapters.length}`, g.pending, g.health, g.defense_date || '', g.room || '',
    ]);
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="thesis-report-${L.today()}.csv"`,
  });
  res.send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
});

// ---------- activity log: search, date range, CSV ----------
const auditQuery = (q, wid) => {
  const where = ['a.workspace_id = ?'];
  const args = [wid];
  if (q.q) { where.push('(a.action LIKE ? OR u.name LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  if (L.isDate(q.from)) { where.push('a.created_at >= ?'); args.push(q.from + ' 00:00:00'); }
  if (L.isDate(q.to)) { where.push('a.created_at <= ?'); args.push(q.to + ' 23:59:59'); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
};
const auditParams = (req) => ({
  q: String(req.query.q || '').trim().slice(0, 100),
  from: L.isDate(req.query.from) ? req.query.from : '',
  to: L.isDate(req.query.to) ? req.query.to : '',
});

router.get('/audit', async (req, res) => {
  const p = auditParams(req);
  const { sql, args } = auditQuery(p, req.user.workspace_id);
  const base = 'FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id ' + sql;
  const PER = 50;
  const total = (await db.get('SELECT COUNT(*) AS n ' + base, args)).n;
  const pages = Math.max(1, Math.ceil(total / PER));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  const rows = await db.all(`SELECT a.*, u.name ${base} ORDER BY a.id DESC LIMIT ${PER} OFFSET ${(page - 1) * PER}`, args);
  res.render('admin/audit', { title: 'Activity log', ...p, rows, total, page, pages });
});

router.get('/audit.csv', async (req, res) => {
  const { sql, args } = auditQuery(auditParams(req), req.user.workspace_id);
  const rows = await db.all('SELECT a.created_at, u.name, a.action FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id ' + sql + ' ORDER BY a.id DESC LIMIT 5000', args);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="activity-log-${L.today()}.csv"` });
  res.send('\ufeff' + [['When', 'Who', 'Action'], ...rows.map((r) => [r.created_at, r.name || 'System', r.action])].map((r) => r.map(csvCell).join(',')).join('\r\n'));
});

// ---------- workspace: join code and deletion request ----------
// A coordinator cannot delete the workspace. They ask the system administrator, who approves or rejects the request.
const latestDeletion = (wid) => db.get('SELECT * FROM workspace_deletions WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [wid]);

router.get('/workspace', async (req, res) => {
  const wid = req.user.workspace_id;
  const n = async (sql) => (await db.get(sql, [wid])).n;
  res.render('admin/workspace', {
    title: 'Workspace',
    request: await latestDeletion(wid),
    counts: {
      students: await n("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role = 'student'"),
      advisers: await n("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role = 'adviser'"),
      groups: await n('SELECT COUNT(*) AS n FROM thesis_groups WHERE workspace_id = ?'),
      files: await n('SELECT COUNT(*) AS n FROM submissions s JOIN chapters c ON c.id = s.chapter_id JOIN thesis_groups g ON g.id = c.group_id WHERE g.workspace_id = ?'),
    },
  });
});

router.post('/workspace/delete-request', async (req, res) => {
  const wid = req.user.workspace_id;
  const ws = res.locals.workspace;
  const back = (msg) => { req.flash('error', msg); return res.redirect('/admin/workspace'); };
  if (!ws) return back('This account has no workspace.');
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!reason) return back('Write the reason for the request.');
  if (String(req.body.confirm_name || '').trim() !== ws.name) return back('The name you typed does not match the workspace name. No request was sent.');
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!row || !(await bcrypt.compare(String(req.body.password || ''), row.password_hash))) return back('Your password is not correct. No request was sent.');
  if ((await latestDeletion(wid))?.status === 'Pending') return back('A deletion request is already waiting for the system administrator.');

  await db.run('INSERT INTO workspace_deletions (workspace_id, requested_by, requested_name, reason) VALUES (?, ?, ?, ?)', [wid, req.user.id, req.user.name, reason]);
  await L.log(req.user.id, 'asked the system administrator to delete the workspace');
  for (const s of await db.all("SELECT id FROM users WHERE role = 'superadmin' AND active = 1")) {
    await L.notify(s.id, `${req.user.name} asked to delete the workspace "${ws.name}".\nReason: ${reason}`, `/system/workspaces/${wid}`, 'system');
  }
  req.flash('ok', 'Your request was sent to the system administrator. Nothing is deleted until they approve it.');
  res.redirect('/admin/workspace');
});

router.post('/workspace/delete-request/cancel', async (req, res) => {
  const wid = req.user.workspace_id;
  const r = await latestDeletion(wid);
  if (r && r.status === 'Pending') {
    await db.run("UPDATE workspace_deletions SET status = 'Cancelled', decided_at = NOW() WHERE id = ?", [r.id]);
    await L.log(req.user.id, 'cancelled the workspace deletion request');
    for (const s of await db.all("SELECT id FROM users WHERE role = 'superadmin' AND active = 1")) {
      await L.notify(s.id, `${req.user.name} cancelled the request to delete the workspace "${res.locals.workspace.name}".`, `/system/workspaces/${wid}`, 'system');
    }
    req.flash('ok', 'The request was cancelled.');
  }
  res.redirect('/admin/workspace');
});

module.exports = router;
