const router = require('express').Router();
const bcrypt = require('bcryptjs');
const mailer = require('../mailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const L = require('../lib');
const { deleteWorkspace } = require('../wsdelete');
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
    res.status(400).render('admin/users', { title: 'Users', users: await allUsers(req.user.workspace_id), form: { name, email, role, student_no: studentNo }, error: msg });
  if (!name) return fail('Enter a name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
  if (role === 'adviser') return fail('Advisers join by invitation. Use the Advisers page.');
  if (!['student', 'panel'].includes(role)) return fail('Choose a role.');
  if (role !== 'panel' && password.length < 8) return fail('The starting password needs at least 8 characters.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return fail('That email is already registered.');
  if (studentNo && !/^[A-Za-z0-9][A-Za-z0-9\-\/]{2,29}$/.test(studentNo)) return fail('The student ID number may use letters, numbers and dashes only.');
  if (studentNo && (await db.get('SELECT 1 FROM users WHERE student_no = ?', [studentNo]))) return fail('That student ID number is already registered.');
  await db.run('INSERT INTO users (name, email, password_hash, role, student_no, workspace_id) VALUES (?, ?, ?, ?, ?, ?)', [name, email, await bcrypt.hash(role === 'panel' ? crypto.randomBytes(24).toString('hex') : password, 10), role, studentNo || null, req.user.workspace_id]);
  await L.log(req.user.id, `added ${name} as ${L.ROLE_LABEL[role].toLowerCase()}`);
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

// ---------- panel members: records only, they never sign in ----------
const panelPage = async (req, res, extra = {}) => {
  const members = await db.all("SELECT * FROM users WHERE role = 'panel' AND workspace_id = ? ORDER BY name", [req.user.workspace_id]);
  for (const m of members) {
    m.groups = (await db.all('SELECT g.name FROM thesis_groups g JOIN group_panelists p ON p.group_id = g.id WHERE p.panel_id = ? ORDER BY g.name', [m.id])).map((g) => g.name);
  }
  return res.render('admin/panel', { title: 'Panel members', members, form: {}, ...extra });
};
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

router.post('/panel', async (req, res) => {
  const p = cleanPerson(req.body);
  const err = await personError(p);
  if (err) return panelPage(req, res.status(400), { error: err, form: p });
  await db.run("INSERT INTO users (name, email, password_hash, role, workspace_id) VALUES (?, ?, ?, 'panel', ?)", [p.name, p.email, await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), req.user.workspace_id]);
  await L.log(req.user.id, `added ${p.name} as panel member`);
  req.flash('ok', `${p.name} was added as a panel member.`);
  res.redirect('/admin/panel');
});

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

// ---------- groups: adviser, panel and defense schedule ----------
router.get('/groups', async (req, res) => res.render('admin/groups', { title: 'Groups', groups: await allGroups(req.user.workspace_id) }));

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

  if (adviserId && !(await db.get("SELECT 1 FROM users WHERE id = ? AND role = 'adviser' AND active = 1 AND workspace_id = ?", [adviserId, wid]))) return fail('Pick an active adviser.');
  for (const p of panel) if (!(await db.get("SELECT 1 FROM users WHERE id = ? AND role = 'panel' AND workspace_id = ? AND (active = 1 OR id IN (SELECT panel_id FROM group_panelists WHERE group_id = ?))", [p, wid, g.id]))) return fail('Choose panel members from the list.');
  if (date) {
    if (!L.isDate(date)) return fail('Enter a valid defense date.');
    if (date < L.today() && date !== g.defense_date) return fail('The defense date cannot be in the past.');
    if (!L.SLOTS.includes(time)) return fail('Pick a defense time.');
    if (!room) return fail('Enter the defense room.');
    if (panel.length < 2) return fail('Choose at least two panel members for a scheduled defense.');
  }

  // An adviser is only a request until they accept it. The group keeps its current adviser (if any) meanwhile.
  const pending = await L.pendingRequestOf(g.id);
  const effective = pending ? pending.adviser_id : g.adviser_id;
  const adviserChanged = adviserId !== effective;
  const newRequest = adviserChanged && adviserId && adviserId !== g.adviser_id;

  await db.transaction(async () => {
    await db.run('UPDATE thesis_groups SET defense_date = ?, defense_time = ?, room = ? WHERE id = ?',
      [date || null, date ? time : null, date ? room : null, g.id]);
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
  res.redirect('/admin/groups');
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
    await db.run('INSERT INTO announcements (title, body, posted_by, workspace_id) VALUES (?, ?, ?, ?)', [title, body, req.user.id, req.user.workspace_id]);
    for (const u of await db.all('SELECT id FROM users WHERE active = 1 AND id != ? AND workspace_id = ?', [req.user.id, req.user.workspace_id])) await L.notify(u.id, `New announcement: ${title}`, '/', 'coordinator');
  });
  await L.log(req.user.id, 'posted an announcement');
  req.flash('ok', 'Announcement posted. Everyone was notified.');
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/delete', async (req, res) => {
  await db.run('DELETE FROM announcements WHERE id = ? AND workspace_id = ?', [Number(req.params.id), req.user.workspace_id]);
  req.flash('ok', 'Announcement removed.');
  res.redirect('/admin/announcements');
});

// ---------- reports ----------
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
      `${g.approved}/5`, g.pending, g.health, g.defense_date || '', g.room || '',
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

// ---------- workspace: join code and permanent deletion ----------
router.get('/workspace', async (req, res) => {
  const wid = req.user.workspace_id;
  const n = async (sql) => (await db.get(sql, [wid])).n;
  res.render('admin/workspace', {
    title: 'Workspace',
    counts: {
      students: await n("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role = 'student'"),
      advisers: await n("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role = 'adviser'"),
      groups: await n('SELECT COUNT(*) AS n FROM thesis_groups WHERE workspace_id = ?'),
      files: await n('SELECT COUNT(*) AS n FROM submissions s JOIN chapters c ON c.id = s.chapter_id JOIN thesis_groups g ON g.id = c.group_id WHERE g.workspace_id = ?'),
    },
  });
});

// Deletes the whole workspace and everything in it. The coordinator must type the workspace's name and their password.
router.post('/workspace/delete', async (req, res) => {
  const wid = req.user.workspace_id;
  const ws = res.locals.workspace;
  const back = (msg) => { req.flash('error', msg); return res.redirect('/admin/workspace'); };
  if (!ws) return back('This account has no workspace.');
  if (String(req.body.confirm_name || '').trim() !== ws.name) return back('The name you typed does not match the workspace name. Nothing was deleted.');
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!row || !(await bcrypt.compare(String(req.body.password || ''), row.password_hash))) return back('Your password is not correct. Nothing was deleted.');

  await deleteWorkspace(wid);
  console.log(`Workspace "${ws.name}" (id ${wid}) was deleted by ${req.user.email}.`);

  // The coordinator's account is gone, so start a clean session and tell them it worked.
  req.session.regenerate((err) => {
    if (err) throw err;
    req.flash('ok', `The workspace "${ws.name}" and all of its data were deleted.`);
    res.redirect('/login');
  });
});

module.exports = router;
