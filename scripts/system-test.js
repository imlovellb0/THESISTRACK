// Checks the system administrator: access rules, workspace and user management, suspension, announcements and settings.
// Use a fresh database: `npm run seed`, then `npm start` in one terminal and `node scripts/system-test.js` in another.
// The sample data has a system administrator, system@school.edu.ph, and two coordinators (admin@ and admin2@school.edu.ph).
// Set BASE if the server is not on http://localhost:3000, and keep DB_NAME the same as the server's.
require('../loadenv');
const db = require('../db');
const BASE = process.env.BASE || 'http://localhost:3000';
let failed = 0;
const check = (cond, msg) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) failed++;
};

class Client {
  constructor() { this.cookies = {}; }
  async req(path, opts = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie } });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return res;
  }
  async page(path) {
    const r = await this.req(path);
    return { status: r.status, body: await r.text(), loc: r.headers.get('location') };
  }
  async token(path) {
    return /name="_csrf" value="([^"]+)"/.exec((await this.page(path)).body)?.[1];
  }
  async post(path, fields, tokenPage) {
    const body = new URLSearchParams({ _csrf: await this.token(tokenPage), ...fields });
    for (const [k, v] of Object.entries(fields)) if (Array.isArray(v)) { body.delete(k); v.forEach((x) => body.append(k, x)); }
    const r = await this.req(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return { status: r.status, loc: r.headers.get('location'), body: r.status >= 300 && r.status < 400 ? '' : await r.text() };
  }
  async login(email, role) {
    return role === 'superadmin'
      ? this.post('/system/login', { email, password: 'password123' }, '/system/login')
      : this.post('/login', { email, password: 'password123', role }, '/login');
  }
}

(async () => {
  await db.init();
  const sys = new Client();
  let r = await sys.login('system@school.edu.ph', 'superadmin');
  check(r.loc === '/system', 'the system administrator signs in and lands on /system');
  for (const url of ['/system', '/system/workspaces', '/system/users', '/system/users?role=student&status=active', '/system/groups', '/system/announcements', '/system/audit', '/system/settings', '/system/users.csv', '/system/audit.csv']) {
    const p = await sys.page(url);
    check(p.status === 200, `${url} opens`);
  }

  const leaving = new Client();
  await leaving.login('system@school.edu.ph', 'superadmin');
  r = await leaving.post('/logout', {}, '/system');
  check(r.loc === '/system/login', 'signing out as the system administrator goes to the system sign-in page');
  const leaving2 = new Client();
  await leaving2.login('juan@student.edu.ph', 'student');
  check((await leaving2.post('/logout', {}, '/student')).loc === '/login', 'signing out as anyone else goes to the normal sign-in page');

  // Other roles cannot open the system pages, and the system administrator cannot open coordinator pages.
  const coord = new Client();
  await coord.login('admin@school.edu.ph', 'admin');
  check((await coord.page('/system')).status === 403, 'a coordinator is refused at /system');
  const student = new Client();
  await student.login('juan@student.edu.ph', 'student');
  check((await student.page('/system/users')).status === 403, 'a student is refused at /system/users');
  check((await sys.page('/admin')).status === 403, 'the system administrator is refused at /admin (no reading thesis data)');
  check((await new Client().page('/system')).loc === '/login', 'a visitor is sent to the login page');
  const wrongRole = new Client();
  r = await wrongRole.login('system@school.edu.ph', 'admin');
  check(r.loc === '/login' && !(await wrongRole.page('/system')).body.includes('System overview'), 'the wrong role on the login form is refused');
  const viaMain = new Client();
  r = await viaMain.post('/login', { email: 'system@school.edu.ph', password: 'password123', role: 'superadmin' }, '/login');
  check(r.loc === '/login' && (await viaMain.page('/system')).loc === '/login', 'the normal sign-in form does not let a system administrator in');
  check(!(await new Client().page('/login')).body.includes('System administrator'), 'the normal sign-in page does not list the system administrator');
  const badSys = new Client();
  r = await badSys.post('/system/login', { email: 'admin@school.edu.ph', password: 'password123' }, '/system/login');
  check(r.loc === '/system/login', 'the system sign-in page refuses a coordinator account');

  // Workspaces
  const wsName = 'BSEd 3C Thesis (test)';
  r = await sys.post('/system/workspaces', { workspace: wsName, name: 'Ms. Test Coordinator', email: 'test.coord@school.edu.ph', password: 'password123' }, '/system/workspaces');
  check(/^\/system\/workspaces\/\d+$/.test(r.loc || ''), 'creates a workspace with its coordinator');
  const wid = (r.loc || '').split('/').pop();
  r = await sys.post('/system/workspaces', { workspace: 'Dup', name: 'Dup', email: 'test.coord@school.edu.ph', password: 'password123' }, '/system/workspaces');
  check(r.status === 400 && r.body.includes('already has an account'), 'refuses a coordinator email that is taken');
  const tc = new Client();
  check((await tc.login('test.coord@school.edu.ph', 'admin')).loc === '/admin', 'the new coordinator signs in');
  check((await tc.page('/admin/users')).body.includes('Ms. Test Coordinator'), 'the new coordinator sees only their own workspace');
  const code = /letter-spacing:\.15em">([A-Z0-9]{8})</.exec((await sys.page(`/system/workspaces/${wid}`)).body)?.[1];
  check(!!code, 'the workspace page shows the join code');
  await sys.post(`/system/workspaces/${wid}/new-code`, {}, `/system/workspaces/${wid}`);
  check(!(await sys.page(`/system/workspaces/${wid}`)).body.includes(`>${code}<`), 'a new join code replaces the old one');
  await sys.post(`/system/workspaces/${wid}/rename`, { name: 'BSEd 3C Renamed' }, `/system/workspaces/${wid}`);
  check((await sys.page('/system/workspaces')).body.includes('BSEd 3C Renamed'), 'renames a workspace');
  await sys.post(`/system/workspaces/${wid}/coordinators`, { name: 'Second Coordinator', email: 'second.coord@school.edu.ph', password: 'password123' }, `/system/workspaces/${wid}`);
  check((await sys.page(`/system/workspaces/${wid}`)).body.includes('Second Coordinator'), 'adds a second coordinator to a workspace');

  // Suspension locks the workspace out, even for a session that is already open.
  await sys.post(`/system/workspaces/${wid}/toggle`, {}, `/system/workspaces/${wid}`);
  check((await tc.page('/admin')).loc === '/login', 'a suspended workspace kicks out a signed-in coordinator');
  const again = new Client();
  r = await again.login('test.coord@school.edu.ph', 'admin');
  check(r.loc === '/login', 'a suspended workspace cannot sign in');
  await sys.post(`/system/workspaces/${wid}/toggle`, {}, `/system/workspaces/${wid}`);
  check((await again.login('test.coord@school.edu.ph', 'admin')).loc === '/admin', 'reactivating lets them sign in again');

  // Users
  const found = await sys.page('/system/users?q=test.coord');
  const uid = /\/system\/users\/(\d+)"/.exec(found.body)?.[1];
  check(!!uid, 'search finds a user across workspaces');
  r = await sys.post(`/system/users/${uid}`, { name: 'Ms. Test Renamed', email: 'test.coord@school.edu.ph' }, `/system/users/${uid}`);
  check(r.loc === `/system/users/${uid}` && (await sys.page(`/system/users/${uid}`)).body.includes('Ms. Test Renamed'), 'edits a user’s name');
  r = await sys.post(`/system/users/${uid}`, { name: 'X', email: 'admin@school.edu.ph' }, `/system/users/${uid}`);
  check(r.status === 400, 'refuses an email another account uses');
  r = await sys.post(`/system/users/${uid}/reset-password`, {}, `/system/users/${uid}`);
  const flash = (await sys.page(`/system/users/${uid}`)).body;
  const temp = /New temporary password for [^:]+: ([A-Za-z0-9]{10})/.exec(flash)?.[1];
  check(!!temp, 'resets a password and shows it once');
  const viaTemp = new Client();
  r = await viaTemp.post('/login', { email: 'test.coord@school.edu.ph', password: temp, role: 'admin' }, '/login');
  check(r.loc === '/admin', 'the temporary password works');
  await sys.post(`/system/users/${uid}/toggle`, {}, `/system/users/${uid}`);
  check((await viaTemp.page('/admin')).loc === '/login', 'a deactivated user is signed out at once');
  await sys.post(`/system/users/${uid}/toggle`, {}, `/system/users/${uid}`);
  const me = /\/system\/users\/(\d+)"/.exec((await sys.page('/system/users?q=system@school')).body)?.[1];
  await sys.post(`/system/users/${me}/toggle`, {}, `/system/users/${me}`);
  check((await sys.page('/system')).status === 200, 'the system administrator cannot deactivate themselves');
  r = await sys.post('/system/users/administrator', { name: 'Second Admin', email: 'system2@school.edu.ph', password: 'short' }, '/system/users');
  check(r.status === 400, 'a system administrator needs a 10 character password');
  r = await sys.post('/system/users/administrator', { name: 'Second Admin', email: 'system2@school.edu.ph', password: 'longenough123' }, '/system/users');
  check(r.loc === '/system/users', 'adds another system administrator');

  // Announcements reach the workspaces' boards and notifications.
  r = await sys.post('/system/announcements', { title: 'Site maintenance Sunday', body: 'The site is offline for an hour.', workspace: 'all' }, '/system/announcements');
  check(r.loc === '/system/announcements', 'sends an announcement to every workspace');
  check((await student.page('/student')).body.includes('Site maintenance Sunday'), 'a student sees it on their board');
  check((await coord.page('/notifications')).body.includes('Site maintenance Sunday'), 'a coordinator is notified');
  check((await student.page('/student')).body.includes('Site maintenance Sunday'), 'an announcement stays on the board as a record (there is no remove button)');

  // Coordinator invitations: opening a workspace needs a single-use code from the system administrator
  const newcomer = 'invited.prof@school.edu.ph';
  const regFields = (code, extra = {}) => ({ workspace: 'Invited Workspace', name: 'Prof. Invited', email: newcomer, code, password: 'password123', confirm: 'password123', consent: 'on', ...extra });
  r = await sys.post('/system/invitations', { name: 'Prof. Invited', email: newcomer }, '/system/workspaces');
  const codeOf = async () => { const body = (await sys.page('/system/workspaces')).body; return /(?:Invitation|New) code for Prof\. Invited: ([A-Z0-9]{8})/.exec(body)?.[1]; }; // the message is shown once
  const code1 = await codeOf();
  check(!!code1, 'the system administrator gets an invitation code to pass on');
  check((await sys.page('/system/workspaces')).body.includes(newcomer), 'the invitation is listed');
  check((await new Client().page(`/register/coordinator?email=${newcomer}`)).body.includes(`value="${newcomer}"`), 'the invitation link fills in the email');
  r = await sys.post('/system/invitations', { name: 'Dup', email: 'admin@school.edu.ph' }, '/system/workspaces');
  check(r.status === 400 && r.body.includes('already has an account'), 'an email that already has an account cannot be invited');
  check((await coord.post('/system/invitations', { name: 'X', email: 'x@y.co' }, '/admin')).status === 403, 'a coordinator cannot send invitations');
  const reg = new Client();
  r = await reg.post('/register/coordinator', regFields('WRONGONE'), '/register/coordinator');
  check(r.status === 400 && r.body.includes('do not match an open invitation'), 'a wrong code is refused');
  r = await reg.post('/register/coordinator', regFields(code1, { email: 'someone.else@school.edu.ph' }), '/register/coordinator');
  check(r.status === 400, 'the code does not work for a different email');
  for (let i = 0; i < 4; i++) await reg.post('/register/coordinator', regFields('WRONGTWO'), '/register/coordinator');
  r = await reg.post('/register/coordinator', regFields(code1), '/register/coordinator');
  check(r.status === 400 && r.body.includes('Too many wrong codes'), 'five wrong codes lock the invitation');
  const inviteId = (await db.get("SELECT id FROM coordinator_invites WHERE email = ? AND status = 'Invited'", [newcomer])).id;
  await sys.post(`/system/invitations/${inviteId}/resend`, {}, '/system/workspaces');
  const code2 = await codeOf();
  check(!!code2 && code2 !== code1, 'a new code can be sent');
  r = await new Client().post('/register/coordinator', regFields(code1), '/register/coordinator');
  check(r.status === 400, 'the old code stops working');
  const ok = new Client();
  r = await ok.post('/register/coordinator', regFields(code2), '/register/coordinator');
  check(r.loc === '/admin', 'the right code opens a workspace and signs the coordinator in');
  check((await ok.page('/admin')).body.includes('Invited Workspace'), 'the new coordinator has the workspace they named');
  check((await db.get('SELECT status FROM coordinator_invites WHERE id = ?', [inviteId])).status === 'Registered', 'the invitation is marked as used');
  r = await new Client().post('/register/coordinator', regFields(code2, { workspace: 'Second try' }), '/register/coordinator');
  check(r.status === 400, 'a used code cannot be used again');
  r = await sys.post('/system/invitations', { name: 'Prof. Cancelled', email: 'cancel.prof@school.edu.ph' }, '/system/workspaces');
  const cancelCode = /Invitation code for Prof\. Cancelled: ([A-Z0-9]{8})/.exec((await sys.page('/system/workspaces')).body)?.[1];
  const cancelId = (await db.get("SELECT id FROM coordinator_invites WHERE email = 'cancel.prof@school.edu.ph'")).id;
  await sys.post(`/system/invitations/${cancelId}/cancel`, {}, '/system/workspaces');
  r = await new Client().post('/register/coordinator', regFields(cancelCode, { email: 'cancel.prof@school.edu.ph' }), '/register/coordinator');
  check(r.status === 400, 'a cancelled invitation does not work');
  await db.run("UPDATE coordinator_invites SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?", [cancelId]);
  await sys.post('/system/settings', {}, '/system/settings');
  r = await new Client().post('/register/coordinator', regFields(code2), '/register/coordinator');
  check(r.status === 403, 'pausing coordinator sign-up blocks registration even with a code');
  await sys.post('/system/settings', { coordinator_signup: 'on' }, '/system/settings');

  // Settings and activity log
  await sys.post('/system/settings', {}, '/system/settings');
  check((await new Client().page('/register/coordinator')).status === 403, 'closing coordinator sign-up blocks the sign-up page');
  await sys.post('/system/settings', { coordinator_signup: 'on' }, '/system/settings');
  check((await new Client().page('/register/coordinator')).status === 200, 'opening it again restores the page');
  await sys.post('/system/cleanup/sessions', {}, '/system/settings');
  check((await sys.page('/system/audit?q=renamed')).body.includes('renamed the workspace'), 'the activity log records system actions');

  // Several accounts at once
  const idOn = async (client, url, name) => new RegExp(`value="([0-9]+)" form="bulkform" aria-label="Select ${name}"`).exec((await client.page(url)).body)?.[1];
  const juanId = await idOn(coord, '/admin/users', 'Juan Dela Cruz');
  const mariaId = await idOn(coord, '/admin/users', 'Maria Santos');
  const dizonId = await idOn(coord, '/admin/users', 'Prof. Ana Dizon');
  const graceId = await idOn(sys, '/system/users?q=second.coord', 'Second Coordinator');
  check(!!(juanId && mariaId && dizonId && graceId), 'the user lists have a tick box for every other account');
  check(!(await coord.page('/admin/users')).body.includes('name="ids" value="' + (await db.get("SELECT id FROM users WHERE email = 'admin@school.edu.ph'")).id + '"'), 'there is no tick box on your own account');
  await coord.post('/admin/users/bulk', { action: 'deactivate', ids: [juanId, mariaId] }, '/admin/users');
  check((await db.get('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?) AND active = 0', [juanId, mariaId])).n === 2, 'a coordinator deactivates several accounts at once');
  await coord.post('/admin/users/bulk', { action: 'activate', ids: [juanId, mariaId] }, '/admin/users');
  check((await db.get('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?) AND active = 1', [juanId, mariaId])).n === 2, 'and activates them again');
  await coord.post('/admin/users/bulk', { action: 'remove', ids: [juanId, dizonId] }, '/admin/users');
  check(!(await db.get('SELECT 1 FROM users WHERE id = ?', [dizonId])), 'a panel member with no thesis work is removed');
  check(!!(await db.get('SELECT 1 FROM users WHERE id = ?', [juanId])), 'a student who is in a group is kept, not removed');
  const myId = (await db.get("SELECT id FROM users WHERE email = 'admin@school.edu.ph'")).id;
  await coord.post('/admin/users/bulk', { action: 'remove', ids: [myId] }, '/admin/users');
  check(!!(await db.get('SELECT 1 FROM users WHERE id = ?', [myId])), 'you cannot remove or deactivate yourself in bulk');
  const other = await db.get("SELECT id FROM users WHERE email = 'reyes@school.edu.ph'");
  const wsTwo = new Client();
  await wsTwo.login('admin2@school.edu.ph', 'admin');
  await wsTwo.post('/admin/users/bulk', { action: 'deactivate', ids: [other.id] }, '/admin/users');
  check((await db.get('SELECT active FROM users WHERE id = ?', [other.id])).active === 1, 'a coordinator cannot reach another workspace’s accounts in bulk');
  await sys.post('/system/users/bulk', { action: 'remove', ids: [graceId], back: '/system/users' }, '/system/users');
  check(!(await db.get('SELECT 1 FROM users WHERE id = ?', [graceId])), 'the system administrator removes a coordinator');
  await sys.post('/system/users/bulk', { action: 'deactivate', ids: [other.id, mariaId] }, '/system/users');
  check((await db.get('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?) AND active = 0', [other.id, mariaId])).n === 2, 'the system administrator deactivates accounts from different workspaces');
  await sys.post('/system/users/bulk', { action: 'activate', ids: [other.id, mariaId] }, '/system/users');
  check((await student.post('/system/users/bulk', { action: 'remove', ids: [mariaId] }, '/student')).status === 403, 'a student cannot use the system bulk route');

  // A coordinator's deletion request: reject needs a note, approve suspends the workspace and locks the delete for the grace period.
  await db.run("INSERT INTO workspace_deletions (workspace_id, requested_name, reason) VALUES (?, 'Coordinator', 'Course finished')", [wid]);
  await sys.post(`/system/workspaces/${wid}/deletion/reject`, { note: '' }, `/system/workspaces/${wid}`);
  check((await db.get('SELECT status FROM workspace_deletions WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [wid])).status === 'Pending', 'rejecting without a note does nothing');
  await sys.post(`/system/workspaces/${wid}/deletion/approve`, { note: 'OK' }, `/system/workspaces/${wid}`);
  check((await db.get('SELECT status FROM workspace_deletions WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [wid])).status === 'Approved' && !(await db.get('SELECT active FROM workspaces WHERE id = ?', [wid])).active, 'approving suspends the workspace');
  await sys.post(`/system/workspaces/${wid}/delete`, { confirm_name: 'BSEd 3C Renamed', password: 'password123' }, `/system/workspaces/${wid}`);
  check(!!(await db.get('SELECT 1 FROM workspaces WHERE id = ?', [wid])), 'the permanent delete is locked during the grace period');
  await sys.post(`/system/workspaces/${wid}/toggle`, {}, `/system/workspaces/${wid}`);
  check((await db.get('SELECT status FROM workspace_deletions WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [wid])).status === 'Reversed', 'reactivating the workspace reverses the approved request');

  // Deleting a workspace needs the exact name and the password.
  r = await sys.post(`/system/workspaces/${wid}/delete`, { confirm_name: 'wrong', password: 'password123' }, `/system/workspaces/${wid}`);
  check((await sys.page('/system/workspaces')).body.includes('BSEd 3C Renamed'), 'a wrong name does not delete the workspace');
  await sys.post(`/system/workspaces/${wid}/delete`, { confirm_name: 'BSEd 3C Renamed', password: 'password123' }, `/system/workspaces/${wid}`);
  check(!(await sys.page('/system/workspaces')).body.includes('/system/workspaces/' + wid + '"'), 'the right name and password delete it');
  check(!(await sys.page('/system/users?q=second.coord')).body.includes('Second Coordinator'), 'its accounts went with it');

  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})();
