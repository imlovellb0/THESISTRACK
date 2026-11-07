const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const db = require('../db');
const L = require('../lib');
const mailer = require('../mailer');
const { deleteWorkspace } = require('../wsdelete');
const { applyBulk, summary: bulkSummary } = require('../userbulk');

// The system administrator manages the whole site: every workspace, every account, system-wide notices, the activity
// log of all workspaces and the site settings. They do not open students' chapters, comments or uploaded files.

const PER = 50;
const EMAIL = /^\S+@\S+\.\S+$/;
const STUDENT_NO = /^[A-Za-z0-9][A-Za-z0-9\-\/]{2,29}$/;
const TEMP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const tempPassword = () => Array.from({ length: 10 }, () => TEMP_CHARS[crypto.randomInt(TEMP_CHARS.length)]).join('');
const clean = (v, max) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, max);
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stops a spreadsheet from running a name that starts like a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const sendCsv = (res, filename, rows) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}-${L.today()}.csv"` });
  res.send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
};
const paging = (req, total) => {
  const pages = Math.max(1, Math.ceil(total / PER));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  return { pages, page, limit: `LIMIT ${PER} OFFSET ${(page - 1) * PER}` };
};
const workspaceById = (id) => db.get('SELECT * FROM workspaces WHERE id = ?', [Number(id)]);
const userById = (id) => db.get('SELECT * FROM users WHERE id = ?', [Number(id)]);
const allWorkspaces = () => db.all('SELECT id, name FROM workspaces ORDER BY name');
const check = (name, ok) => ({ name, ok });

// ---------- overview ----------
function folderSize(dir) {
  let bytes = 0, files = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile()) continue;
    files++;
    bytes += fs.statSync(`${dir}/${f.name}`).size;
  }
  return { bytes, files };
}
const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);

router.get('/', async (req, res) => {
  const n = async (sql) => (await db.get(sql)).n;
  const roles = Object.fromEntries((await db.all('SELECT role, COUNT(*) AS n FROM users GROUP BY role')).map((r) => [r.role, r.n]));
  const t0 = Date.now();
  await db.ping();
  const storage = folderSize(db.UPLOAD_DIR);
  res.render('system/overview', {
    title: 'System overview',
    counts: {
      workspaces: await n('SELECT COUNT(*) AS n FROM workspaces'),
      suspended: await n('SELECT COUNT(*) AS n FROM workspaces WHERE active = 0'),
      coordinators: roles.admin || 0, advisers: roles.adviser || 0, students: roles.student || 0, panel: roles.panel || 0,
      inactive: await n('SELECT COUNT(*) AS n FROM users WHERE active = 0'),
      groups: await n('SELECT COUNT(*) AS n FROM thesis_groups'),
      noAdviser: await n('SELECT COUNT(*) AS n FROM thesis_groups WHERE adviser_id IS NULL'),
      submissions: await n('SELECT COUNT(*) AS n FROM submissions'),
    },
    attention: await db.all(
      `SELECT w.id, w.name,
         (SELECT COUNT(*) FROM users u WHERE u.workspace_id = w.id AND u.role = 'admin' AND u.active = 1) AS coordinators
       FROM workspaces w WHERE w.active = 1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.workspace_id = w.id AND u.role = 'admin' AND u.active = 1)`
    ),
    activity: await db.all('SELECT a.*, u.name, w.name AS workspace_name FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN workspaces w ON w.id = a.workspace_id ORDER BY a.id DESC LIMIT 12'),
    health: [
      check(`Database answers in ${Date.now() - t0} ms`, true),
      check(`Uploads: ${storage.files} file${storage.files === 1 ? '' : 's'}, ${mb(storage.bytes)} MB`, true),
      check(mailer.configured() ? 'Email is set up' : 'Email is not set up: invitations show their code on screen instead', mailer.configured()),
      check(process.env.NODE_ENV === 'production' ? 'Running as the live site' : 'Running in development mode', true),
    ],
  });
});

// ---------- workspaces ----------
const workspaceRows = () => db.all(
  `SELECT w.*,
     (SELECT COUNT(*) FROM users u WHERE u.workspace_id = w.id AND u.role = 'admin') AS coordinators,
     (SELECT COUNT(*) FROM users u WHERE u.workspace_id = w.id AND u.role = 'adviser') AS advisers,
     (SELECT COUNT(*) FROM users u WHERE u.workspace_id = w.id AND u.role = 'student') AS students,
     (SELECT COUNT(*) FROM thesis_groups g WHERE g.workspace_id = w.id) AS group_count
   FROM workspaces w ORDER BY w.name`
);
const INVITE_DAYS = 7;
const inviteRows = () => db.all('SELECT *, (expires_at < NOW()) AS expired FROM coordinator_invites ORDER BY id DESC LIMIT 50');
const GRACE_DAYS = 30; // an approved deletion suspends the workspace this long before it can be erased
const latestDeletion = (wid) => db.get('SELECT *, (delete_after IS NOT NULL AND delete_after > NOW()) AS in_grace FROM workspace_deletions WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [wid]);
const workspacesPage = async (res, extra = {}) => res.render('system/workspaces', {
  title: 'Workspaces', workspaces: await Promise.all((await workspaceRows()).map(async (w) => ({ ...w, deletion: await latestDeletion(w.id) }))), invites: await inviteRows(), ttlDays: INVITE_DAYS, mailReady: mailer.configured(), form: {}, inviteForm: {}, errorIn: '', ...extra,
});

// ---------- coordinator invitations: a single-use code for one email address ----------
async function sendCoordinatorInvite(inv, code, req) {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  return mailer.send({
    to: inv.email,
    subject: 'Your ThesisTrack coordinator invitation',
    text:
      `Hello ${inv.name},

The system administrator invited you to open a thesis workspace on ThesisTrack as a coordinator.

` +
      `Your invitation code: ${code}
It works once, for this email address, for ${INVITE_DAYS} days.

` +
      `To finish, open ${base}/register/coordinator?email=${encodeURIComponent(inv.email)} , enter the code, name your workspace and choose a password.
` +
      `If you did not expect this, ignore this email.
`,
  });
}

router.post('/invitations', async (req, res) => {
  const name = clean(req.body.name, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const fail = (msg) => workspacesPage(res.status(400), { error: msg, errorIn: 'invite', inviteForm: { name, email } });
  if (!name) return fail('Enter the coordinator’s name.');
  if (!EMAIL.test(email)) return fail('Enter a valid email address.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return fail('That email already has an account.');
  const code = db.newCode(8);
  await db.transaction(async () => {
    await db.run("UPDATE coordinator_invites SET status = 'Cancelled' WHERE email = ? AND status = 'Invited'", [email]);
    await db.run(`INSERT INTO coordinator_invites (name, email, code_hash, expires_at, invited_by) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ${INVITE_DAYS} DAY), ?)`,
      [name, email, await bcrypt.hash(code, 10), req.user.id]);
  });
  await L.log(req.user.id, `invited ${name} to open a workspace as a coordinator`);
  // The code is shown once here too, so it can be passed on in person if the email does not arrive.
  let how;
  try { how = (await sendCoordinatorInvite({ name, email }, code, req)).sent ? `It was emailed to ${email}.` : 'Email is not set up, so it was saved in outbox/mail.log.'; }
  catch (e) { console.error(e); how = 'The email could not be sent, so give the code to them yourself.'; }
  req.flash('ok', `Invitation code for ${name}: ${code}  (shown only now). ${how}`);
  res.redirect('/system/workspaces');
});

router.post('/invitations/:id/resend', async (req, res) => {
  const inv = await db.get("SELECT * FROM coordinator_invites WHERE id = ? AND status = 'Invited'", [Number(req.params.id)]);
  if (!inv) { req.flash('error', 'That invitation is no longer open.'); return res.redirect('/system/workspaces'); }
  const code = db.newCode(8);
  await db.run(`UPDATE coordinator_invites SET code_hash = ?, attempts = 0, expires_at = DATE_ADD(NOW(), INTERVAL ${INVITE_DAYS} DAY) WHERE id = ?`, [await bcrypt.hash(code, 10), inv.id]);
  await L.log(req.user.id, `sent a new invitation code to ${inv.name}`);
  let how;
  try { how = (await sendCoordinatorInvite(inv, code, req)).sent ? `It was emailed to ${inv.email}.` : 'Email is not set up, so it was saved in outbox/mail.log.'; }
  catch (e) { console.error(e); how = 'The email could not be sent, so give the code to them yourself.'; }
  req.flash('ok', `New code for ${inv.name}: ${code}  (shown only now). The old code no longer works. ${how}`);
  res.redirect('/system/workspaces');
});

router.post('/invitations/:id/cancel', async (req, res) => {
  const r = await db.run("UPDATE coordinator_invites SET status = 'Cancelled' WHERE id = ? AND status = 'Invited'", [Number(req.params.id)]);
  if (r.changes) await L.log(req.user.id, 'cancelled a coordinator invitation');
  req.flash('ok', 'Invitation cancelled. The code no longer works.');
  res.redirect('/system/workspaces');
});

router.get('/workspaces', (req, res) => workspacesPage(res));

// New workspace together with its first coordinator.
router.post('/workspaces', async (req, res) => {
  const wname = clean(req.body.workspace, 120);
  const name = clean(req.body.name, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const password = String(req.body.password || '');
  const fail = (msg) => workspacesPage(res.status(400), { error: msg, errorIn: 'workspace', form: { workspace: wname, name, email } });
  if (!wname) return fail('Give the workspace a name.');
  if (!name) return fail('Enter the coordinator’s name.');
  if (!EMAIL.test(email)) return fail('Enter a valid email address.');
  if (password.length < 8) return fail('Use a starting password with at least 8 characters.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return fail('That email already has an account.');
  const ws = await db.transaction(async () => {
    const w = await db.createWorkspace(wname);
    await db.run("INSERT INTO users (name, email, password_hash, role, workspace_id) VALUES (?, ?, ?, 'admin', ?)", [name, email, await bcrypt.hash(password, 10), w.id]);
    return w;
  });
  await L.log(req.user.id, `created the workspace ${wname} with ${name} as its coordinator`);
  req.flash('ok', `${wname} was created. Share the starting password with ${name} privately.`);
  res.redirect(`/system/workspaces/${ws.id}`);
});

const workspacePage = async (req, res, extra = {}) => {
  const ws = await workspaceById(req.params.id);
  if (!ws) return res.status(404).render('error', { title: 'Not found', message: 'That workspace does not exist.' });
  const n = async (sql) => (await db.get(sql, [ws.id])).n;
  res.render('system/workspace', {
    title: ws.name, ws, form: {}, request: await latestDeletion(ws.id), graceDays: GRACE_DAYS, ...extra,
    staff: await db.all("SELECT id, name, email, role, active FROM users WHERE workspace_id = ? AND role IN ('admin','adviser') ORDER BY role, name", [ws.id]),
    counts: {
      students: await n("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role = 'student'"),
      panel: await n("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role = 'panel'"),
      groups: await n('SELECT COUNT(*) AS n FROM thesis_groups WHERE workspace_id = ?'),
      files: await n('SELECT COUNT(*) AS n FROM submissions s JOIN chapters c ON c.id = s.chapter_id JOIN thesis_groups g ON g.id = c.group_id WHERE g.workspace_id = ?'),
    },
  });
};

router.get('/workspaces/:id', (req, res) => workspacePage(req, res));

router.post('/workspaces/:id/rename', async (req, res) => {
  const ws = await workspaceById(req.params.id);
  const name = clean(req.body.name, 120);
  if (!ws) req.flash('error', 'Workspace not found.');
  else if (!name) req.flash('error', 'Enter a name.');
  else {
    await db.run('UPDATE workspaces SET name = ? WHERE id = ?', [name, ws.id]);
    await L.log(req.user.id, `renamed the workspace ${ws.name} to ${name}`);
    req.flash('ok', 'The workspace was renamed.');
  }
  res.redirect(`/system/workspaces/${req.params.id}`);
});

// A new join code stops the old one from working, for example after it was shared too widely.
router.post('/workspaces/:id/new-code', async (req, res) => {
  const ws = await workspaceById(req.params.id);
  if (!ws) req.flash('error', 'Workspace not found.');
  else {
    for (;;) {
      try { await db.run('UPDATE workspaces SET join_code = ? WHERE id = ?', [db.newJoinCode(), ws.id]); break; }
      catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
    }
    await L.log(req.user.id, `made a new join code for ${ws.name}`);
    req.flash('ok', 'A new join code was made. The old code no longer works.');
  }
  res.redirect(`/system/workspaces/${req.params.id}`);
});

router.post('/workspaces/:id/toggle', async (req, res) => {
  const ws = await workspaceById(req.params.id);
  if (!ws) req.flash('error', 'Workspace not found.');
  else {
    await db.run('UPDATE workspaces SET active = ? WHERE id = ?', [ws.active ? 0 : 1, ws.id]);
    if (!ws.active) await db.run("UPDATE workspace_deletions SET status = 'Reversed', decided_at = NOW() WHERE workspace_id = ? AND status = 'Approved'", [ws.id]);
    await L.log(req.user.id, `${ws.active ? 'suspended' : 'reactivated'} the workspace ${ws.name}`);
    req.flash('ok', ws.active ? `${ws.name} is suspended. Nobody in it can sign in until you switch it back on.` : `${ws.name} is active again.`);
  }
  res.redirect(`/system/workspaces/${req.params.id}`);
});

router.post('/workspaces/:id/coordinators', async (req, res) => {
  const ws = await workspaceById(req.params.id);
  if (!ws) return res.redirect('/system/workspaces');
  const name = clean(req.body.name, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const password = String(req.body.password || '');
  const fail = (msg) => workspacePage(req, res.status(400), { error: msg, form: { name, email } });
  if (!name) return fail('Enter the coordinator’s name.');
  if (!EMAIL.test(email)) return fail('Enter a valid email address.');
  if (password.length < 8) return fail('Use a starting password with at least 8 characters.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return fail('That email already has an account.');
  await db.run("INSERT INTO users (name, email, password_hash, role, workspace_id) VALUES (?, ?, ?, 'admin', ?)", [name, email, await bcrypt.hash(password, 10), ws.id]);
  await L.log(req.user.id, `added ${name} as a coordinator of ${ws.name}`);
  req.flash('ok', `${name} was added as a coordinator. Share the starting password with them privately.`);
  res.redirect(`/system/workspaces/${ws.id}`);
});

router.post('/workspaces/:id/deletion/approve', async (req, res) => {
  const ws = await workspaceById(req.params.id);
  const r = ws && await latestDeletion(ws.id);
  if (!r || r.status !== 'Pending') { req.flash('error', 'There is no pending deletion request for this workspace.'); return res.redirect(`/system/workspaces/${req.params.id}`); }
  const note = clean(req.body.note, 1000);
  await db.transaction(async () => {
    await db.run('UPDATE workspaces SET active = 0 WHERE id = ?', [ws.id]);
    await db.run(`UPDATE workspace_deletions SET status = 'Approved', decision_note = ?, decided_at = NOW(), delete_after = DATE_ADD(NOW(), INTERVAL ${GRACE_DAYS} DAY) WHERE id = ?`, [note || null, r.id]);
  });
  await L.log(req.user.id, `approved the deletion request of ${ws.name}; it is suspended for ${GRACE_DAYS} days`);
  req.flash('ok', `Approved. ${ws.name} is suspended now. It can be permanently deleted after ${GRACE_DAYS} days, and you can reactivate it until then.`);
  res.redirect(`/system/workspaces/${ws.id}`);
});

router.post('/workspaces/:id/deletion/reject', async (req, res) => {
  const ws = await workspaceById(req.params.id);
  const r = ws && await latestDeletion(ws.id);
  if (!r || r.status !== 'Pending') { req.flash('error', 'There is no pending deletion request for this workspace.'); return res.redirect(`/system/workspaces/${req.params.id}`); }
  const note = clean(req.body.note, 1000);
  if (!note) { req.flash('error', 'Write a note so the coordinator knows why the request was rejected.'); return res.redirect(`/system/workspaces/${ws.id}`); }
  await db.run("UPDATE workspace_deletions SET status = 'Rejected', decision_note = ?, decided_at = NOW() WHERE id = ?", [note, r.id]);
  await L.log(req.user.id, `rejected the deletion request of ${ws.name}`);
  if (r.requested_by) await L.notify(r.requested_by, `The system administrator rejected your request to delete the workspace.\
Note: ${note}`, '/admin/workspace', 'system');
  req.flash('ok', 'The request was rejected and the coordinator was told.');
  res.redirect(`/system/workspaces/${ws.id}`);
});

router.post('/workspaces/:id/delete', async (req, res) => {
  const ws = await workspaceById(req.params.id);
  const back = (msg) => { req.flash('error', msg); return res.redirect(`/system/workspaces/${req.params.id}`); };
  if (!ws) return res.redirect('/system/workspaces');
  const asked = await latestDeletion(ws.id);
  if (asked && asked.status === 'Approved' && asked.in_grace) return back(`The grace period has not ended. It can be permanently deleted after ${L.fmtDate(asked.delete_after)}. Nothing was deleted.`);
  if (clean(req.body.confirm_name, 120) !== ws.name) return back('The name you typed does not match the workspace name. Nothing was deleted.');
  const me = await userById(req.user.id);
  if (!(await bcrypt.compare(String(req.body.password || ''), me.password_hash))) return back('Your password is not correct. Nothing was deleted.');
  await deleteWorkspace(ws.id);
  await L.log(req.user.id, `deleted the workspace ${ws.name} and all of its data`);
  console.log(`Workspace "${ws.name}" (id ${ws.id}) was deleted by ${req.user.email}.`);
  req.flash('ok', `The workspace "${ws.name}" and all of its data were deleted.`);
  res.redirect('/system/workspaces');
});

// ---------- users ----------
const userFilter = (q) => {
  const where = [];
  const args = [];
  if (q.q) { where.push('(u.name LIKE ? OR u.email LIKE ? OR u.student_no LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  if (L.ROLE_LABEL[q.role]) { where.push('u.role = ?'); args.push(q.role); }
  if (q.workspace === 'none') where.push('u.workspace_id IS NULL');
  else if (q.workspace) { where.push('u.workspace_id = ?'); args.push(Number(q.workspace)); }
  if (q.status === 'active') where.push('u.active = 1');
  if (q.status === 'inactive') where.push('u.active = 0');
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
};
const userParams = (req) => ({
  q: clean(req.query.q, 100),
  role: String(req.query.role || ''),
  workspace: String(req.query.workspace || '').replace(/[^0-9a-z]/g, ''),
  status: ['active', 'inactive'].includes(req.query.status) ? req.query.status : '',
});
const USER_FROM = 'FROM users u LEFT JOIN workspaces w ON w.id = u.workspace_id ';

const usersPage = async (req, res, extra = {}) => {
  const p = userParams(req);
  const { sql, args } = userFilter(p);
  const total = (await db.get('SELECT COUNT(*) AS n ' + USER_FROM + sql, args)).n;
  const pg = paging(req, total);
  const rows = await db.all(`SELECT u.id, u.name, u.email, u.role, u.active, u.student_no, u.workspace_id, u.created_at, w.name AS workspace_name ${USER_FROM} ${sql} ORDER BY u.role, u.name ${pg.limit}`, args);
  res.render('system/users', { title: 'Users', ...p, rows, total, ...pg, workspaces: await allWorkspaces(), roleLabels: L.ROLE_LABEL, form: {}, ...extra });
};

router.get('/users', (req, res) => usersPage(req, res));

router.get('/users.csv', async (req, res) => {
  const { sql, args } = userFilter(userParams(req));
  const rows = await db.all(`SELECT u.name, u.email, u.role, u.student_no, u.active, u.created_at, w.name AS workspace_name ${USER_FROM} ${sql} ORDER BY w.name, u.role, u.name LIMIT 20000`, args);
  sendCsv(res, 'users', [['Name', 'Email', 'Role', 'Workspace', 'Student ID', 'Active', 'Created'],
    ...rows.map((r) => [r.name, r.email, L.ROLE_LABEL[r.role], r.workspace_name || '', r.student_no || '', r.active ? 'Yes' : 'No', r.created_at])]);
});

router.post('/users/administrator', async (req, res) => {
  const name = clean(req.body.name, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const password = String(req.body.password || '');
  const fail = (msg) => usersPage(req, res.status(400), { error: msg, form: { name, email } });
  if (!name) return fail('Enter a name.');
  if (!EMAIL.test(email)) return fail('Enter a valid email address.');
  if (password.length < 10) return fail('A system administrator needs a password of at least 10 characters.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) return fail('That email already has an account.');
  await db.run("INSERT INTO users (name, email, password_hash, role, consent_at) VALUES (?, ?, ?, 'superadmin', NOW())", [name, email, await bcrypt.hash(password, 10)]);
  await L.log(req.user.id, `added ${name} as a system administrator`);
  req.flash('ok', `${name} was added as a system administrator.`);
  res.redirect('/system/users');
});

// Several accounts at once, in any workspace. The system administrator may also remove coordinators.
router.post('/users/bulk', async (req, res) => {
  const action = String(req.body.action || '');
  const ids = [].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const back = String(req.body.back || '').startsWith('/system/users') ? req.body.back : '/system/users';
  if (!['activate', 'deactivate', 'remove'].includes(action)) req.flash('error', 'Choose what to do with the selected accounts.');
  else if (!ids.length) req.flash('error', 'Tick at least one account first.');
  else {
    const result = await applyBulk(action, await db.all('SELECT * FROM users WHERE id IN (?) ORDER BY name', [ids]), req.user, { removeCoordinators: true });
    req.flash(result.done ? 'ok' : 'error', bulkSummary(action, result));
  }
  res.redirect(back);
});

const userPage = async (req, res, extra = {}) => {
  const u = await userById(req.params.id);
  if (!u) return res.status(404).render('error', { title: 'Not found', message: 'That user does not exist.' });
  const w = u.workspace_id ? await workspaceById(u.workspace_id) : null;
  const groups = u.role === 'student'
    ? await db.all('SELECT g.id, g.name FROM thesis_groups g JOIN group_members m ON m.group_id = g.id WHERE m.student_id = ?', [u.id])
    : u.role === 'adviser' ? await db.all('SELECT id, name FROM thesis_groups WHERE adviser_id = ?', [u.id]) : [];
  const activity = await db.all('SELECT * FROM activity_log WHERE actor_id = ? ORDER BY id DESC LIMIT 10', [u.id]);
  res.render('system/user', { title: u.name, u, w, groups, activity, self: u.id === req.user.id, ...extra });
};

router.get('/users/:id', (req, res) => userPage(req, res));

router.post('/users/:id', async (req, res) => {
  const u = await userById(req.params.id);
  if (!u) return res.redirect('/system/users');
  const name = clean(req.body.name, 255);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const studentNo = u.role === 'student' ? clean(req.body.student_no, 30) : null;
  const fail = (msg) => userPage(req, res.status(400), { error: msg });
  const cls = u.role === 'student' ? L.readClass(req.body, true) : { value: {} };
  if (cls.error) return fail(cls.error);
  if (!name) return fail('Enter a name.');
  if (!EMAIL.test(email)) return fail('Enter a valid email address.');
  if (await db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', [email, u.id])) return fail('Another account already uses that email.');
  if (studentNo && !STUDENT_NO.test(studentNo)) return fail('The student ID number may use letters, numbers and dashes only.');
  if (studentNo && (await db.get('SELECT 1 FROM users WHERE student_no = ? AND id != ?', [studentNo, u.id]))) return fail('That student ID number is already registered.');
  await db.run('UPDATE users SET name = ?, email = ?, student_no = ?, course = ?, year_level = ?, section = ? WHERE id = ?', [name, email, u.role === 'student' ? studentNo || null : u.student_no, ...(u.role === 'student' ? [cls.value.course, cls.value.year_level, cls.value.section] : [u.course, u.year_level, u.section]), u.id]);
  await L.log(req.user.id, `edited the account of ${u.name}`);
  req.flash('ok', 'The account was saved.');
  res.redirect(`/system/users/${u.id}`);
});

const guarded = (handler) => async (req, res) => {
  const u = await userById(req.params.id);
  const back = req.body.back && req.body.back.startsWith('/system/') ? req.body.back : `/system/users/${req.params.id}`;
  if (!u) req.flash('error', 'User not found.');
  else if (u.id === req.user.id) req.flash('error', 'Use My account for your own password, and ask another system administrator to change your status.');
  else await handler(u, req);
  res.redirect(back);
};

router.post('/users/:id/toggle', guarded(async (u, req) => {
  await db.run('UPDATE users SET active = ? WHERE id = ?', [u.active ? 0 : 1, u.id]);
  await L.log(req.user.id, `${u.active ? 'deactivated' : 'activated'} ${u.name}`);
  req.flash('ok', `${u.name} is now ${u.active ? 'inactive' : 'active'}.`);
}));

router.post('/users/:id/reset-password', guarded(async (u, req) => {
  const temp = tempPassword();
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(temp, 10), u.id]);
  await db.run('DELETE FROM sessions WHERE data LIKE ? OR data LIKE ?', [`%"userId":${u.id},%`, `%"userId":${u.id}}%`]);
  await L.log(req.user.id, `reset the password of ${u.name}`);
  await L.notify(u.id, 'The system administrator reset your password. Change it under My account after you sign in.', '/account', 'system');
  req.flash('ok', `New temporary password for ${u.name}: ${temp}  Give it to them privately. They should change it under My account.`);
}));

router.post('/users/:id/sign-out', guarded(async (u, req) => {
  const r = await db.run('DELETE FROM sessions WHERE data LIKE ? OR data LIKE ?', [`%"userId":${u.id},%`, `%"userId":${u.id}}%`]);
  await L.log(req.user.id, `signed ${u.name} out of every device`);
  req.flash('ok', `${u.name} was signed out of ${r.changes} session${r.changes === 1 ? '' : 's'}.`);
}));

// ---------- groups (read-only overview of every workspace) ----------
router.get('/groups', async (req, res) => {
  const q = clean(req.query.q, 100);
  const workspace = String(req.query.workspace || '').replace(/[^0-9]/g, '');
  const where = [];
  const args = [];
  if (q) { where.push('(g.name LIKE ? OR g.title LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (workspace) { where.push('g.workspace_id = ?'); args.push(Number(workspace)); }
  const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await db.get('SELECT COUNT(*) AS n FROM thesis_groups g ' + sql, args)).n;
  const pg = paging(req, total);
  const groups = await Promise.all((await db.all(
    `SELECT g.*, w.name AS workspace_name, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
     FROM thesis_groups g LEFT JOIN workspaces w ON w.id = g.workspace_id ${sql} ORDER BY w.name, g.name ${pg.limit}`, args)).map(L.summarize));
  res.render('system/groups', { title: 'Groups', groups, q, workspace, total, ...pg, workspaces: await allWorkspaces() });
});

// ---------- announcements to every workspace (or one) ----------
const broadcastsPage = async (res, extra = {}) => res.render('system/announcements', {
  title: 'Announcements',
  workspaces: await allWorkspaces(),
  items: await db.all(
    `SELECT a.broadcast_id, MIN(a.title) AS title, MIN(a.body) AS body, MIN(a.created_at) AS created_at, COUNT(*) AS workspace_count
     FROM announcements a WHERE a.broadcast_id IS NOT NULL GROUP BY a.broadcast_id ORDER BY MIN(a.id) DESC LIMIT 30`),
  form: {}, ...extra,
});

router.get('/announcements', (req, res) => broadcastsPage(res));

router.post('/announcements', async (req, res) => {
  const title = clean(req.body.title, 200);
  const body = String(req.body.body || '').trim().slice(0, 5000);
  const target = String(req.body.workspace || 'all');
  const roles = [].concat(req.body.roles || []).filter((r) => ['student', 'adviser', 'admin'].includes(r));
  const fail = (msg) => broadcastsPage(res.status(400), { error: msg, form: { title, body, workspace: target, roles } });
  if (!title) return fail('Enter a title.');
  if (!body) return fail('Write the announcement.');
  const spaces = target === 'all' ? await allWorkspaces() : [await workspaceById(target)].filter(Boolean);
  if (!spaces.length) return fail('Choose a workspace.');
  const bid = crypto.randomBytes(8).toString('hex');
  let notified = 0;
  await db.transaction(async () => {
    for (const w of spaces) {
      const info = await db.run('INSERT INTO announcements (title, body, posted_by, workspace_id, broadcast_id) VALUES (?, ?, ?, ?, ?)', [title, body, req.user.id, w.id, bid]);
      for (const u of await db.all(`SELECT id FROM users WHERE active = 1 AND workspace_id = ? AND role IN (${(roles.length ? roles : ['student', 'adviser', 'admin']).map(() => '?').join(',')})`, [w.id, ...(roles.length ? roles : ['student', 'adviser', 'admin'])])) {
        await L.notify(u.id, `New announcement: ${title}`, `/announcements/${info.lastInsertRowid}`, 'system');
        notified++;
      }
    }
  });
  await L.log(req.user.id, `sent the announcement "${title}" to ${target === 'all' ? 'every workspace' : spaces[0].name}`);
  req.flash('ok', `Announcement sent to ${spaces.length} workspace${spaces.length === 1 ? '' : 's'}. ${notified} people were notified.`);
  res.redirect('/system/announcements');
});

// ---------- activity log across all workspaces ----------
const auditQuery = (q) => {
  const where = [];
  const args = [];
  if (q.q) { where.push('(a.action LIKE ? OR u.name LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.workspace === 'none') where.push('a.workspace_id IS NULL');
  else if (q.workspace) { where.push('a.workspace_id = ?'); args.push(Number(q.workspace)); }
  if (L.isDate(q.from)) { where.push('a.created_at >= ?'); args.push(q.from + ' 00:00:00'); }
  if (L.isDate(q.to)) { where.push('a.created_at <= ?'); args.push(q.to + ' 23:59:59'); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
};
const auditParams = (req) => ({
  q: clean(req.query.q, 100),
  workspace: String(req.query.workspace || '').replace(/[^0-9a-z]/g, ''),
  from: L.isDate(req.query.from) ? req.query.from : '',
  to: L.isDate(req.query.to) ? req.query.to : '',
});
const AUDIT_FROM = 'FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN workspaces w ON w.id = a.workspace_id ';

router.get('/audit', async (req, res) => {
  const p = auditParams(req);
  const { sql, args } = auditQuery(p);
  const total = (await db.get('SELECT COUNT(*) AS n ' + AUDIT_FROM + sql, args)).n;
  const pg = paging(req, total);
  const rows = await db.all(`SELECT a.*, u.name, w.name AS workspace_name ${AUDIT_FROM} ${sql} ORDER BY a.id DESC ${pg.limit}`, args);
  res.render('system/audit', { title: 'Activity log', ...p, rows, total, ...pg, workspaces: await allWorkspaces() });
});

router.get('/audit.csv', async (req, res) => {
  const { sql, args } = auditQuery(auditParams(req));
  const rows = await db.all(`SELECT a.created_at, u.name, w.name AS workspace_name, a.action ${AUDIT_FROM} ${sql} ORDER BY a.id DESC LIMIT 20000`, args);
  sendCsv(res, 'activity-log', [['When', 'Who', 'Workspace', 'Action'], ...rows.map((r) => [r.created_at, r.name || 'System', r.workspace_name || '', r.action])]);
});

// ---------- system: settings, health and clean-up ----------
const tableCount = async (t) => (await db.get(`SELECT COUNT(*) AS n FROM \`${t}\``)).n;

router.get('/settings', async (req, res) => {
  const storage = folderSize(db.UPLOAD_DIR);
  res.render('system/settings', {
    title: 'System',
    signupOpen: (await db.getSetting('coordinator_signup', 'on')) === 'on',
    info: [
      ['Mode', process.env.NODE_ENV === 'production' ? 'Live site' : 'Development'],
      ['Database', db.DB_NAME],
      ['Email', mailer.configured() ? 'Set up' : 'Not set up'],
      ['Uploads folder', `${storage.files} file${storage.files === 1 ? '' : 's'}, ${mb(storage.bytes)} MB`],
      ['Server running for', `${Math.floor(process.uptime() / 3600)} h ${Math.floor((process.uptime() % 3600) / 60)} min`],
      ['Node.js', process.version],
      ['Server memory', `${mb(process.memoryUsage().rss)} MB used, ${mb(os.freemem())} MB free on this computer`],
    ],
    tables: await Promise.all(['workspaces', 'users', 'thesis_groups', 'chapters', 'submissions', 'comments', 'consultations', 'notifications', 'activity_log', 'sessions'].map(async (t) => [t, await tableCount(t)]).map((p) => p.catch(() => null))),
    junk: {
      sessions: (await db.get('SELECT COUNT(*) AS n FROM sessions WHERE expires < ?', [Date.now()])).n,
      resets: (await db.get('SELECT COUNT(*) AS n FROM password_resets WHERE expires_at < NOW() OR used_at IS NOT NULL')).n,
      invites: (await db.get("SELECT COUNT(*) AS n FROM adviser_invites WHERE status = 'Cancelled' OR (status = 'Invited' AND expires_at < NOW())")).n +
        (await db.get("SELECT COUNT(*) AS n FROM coordinator_invites WHERE status = 'Cancelled' OR (status = 'Invited' AND expires_at < NOW())")).n +
        (await db.get("SELECT COUNT(*) AS n FROM panel_invites WHERE status = 'Cancelled' OR (status = 'Invited' AND expires_at < NOW())")).n,
      notifications: (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE is_read = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)')).n,
    },
  });
});

router.post('/settings', async (req, res) => {
  const open = req.body.coordinator_signup === 'on';
  await db.setSetting('coordinator_signup', open ? 'on' : 'off');
  await L.log(req.user.id, `${open ? 'opened' : 'closed'} coordinator sign-up`);
  req.flash('ok', open ? 'Invited teachers can open their workspace again.' : 'Coordinator sign-up is paused. Invitation codes do not work until you turn it back on.');
  res.redirect('/system/settings');
});

const TASKS = {
  sessions: ['expired sign-in sessions', () => db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()])],
  resets: ['used or expired password reset links', () => db.run('DELETE FROM password_resets WHERE expires_at < NOW() OR used_at IS NOT NULL')],
  invites: ['cancelled or expired invitations', async () => {
    const a = await db.run("DELETE FROM adviser_invites WHERE status = 'Cancelled' OR (status = 'Invited' AND expires_at < NOW())");
    const c = await db.run("DELETE FROM coordinator_invites WHERE status = 'Cancelled' OR (status = 'Invited' AND expires_at < NOW())");
    const p = await db.run("DELETE FROM panel_invites WHERE status = 'Cancelled' OR (status = 'Invited' AND expires_at < NOW())");
    return { changes: a.changes + c.changes + p.changes };
  }],
  notifications: ['read notifications older than 90 days', () => db.run('DELETE FROM notifications WHERE is_read = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)')],
};
router.post('/cleanup/:task', async (req, res) => {
  const t = TASKS[req.params.task];
  if (!t) return res.redirect('/system/settings');
  const r = await t[1]();
  await L.log(req.user.id, `cleared ${r.changes} ${t[0]}`);
  req.flash('ok', `Cleared ${r.changes} ${t[0]}.`);
  res.redirect('/system/settings');
});

module.exports = router;
