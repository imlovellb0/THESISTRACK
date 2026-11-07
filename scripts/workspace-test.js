// Proves that one coordinator's workspace cannot see or change another's.
// Use a fresh database: `npm run seed`, then `npm start` in one terminal and `node scripts/workspace-test.js` in another.
// The sample data has two workspaces: admin@school.edu.ph (BSIT 4A) and admin2@school.edu.ph (BSCS 4B).
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
  async login(email) {
    await this.post('/login', { email, password: 'password123' }, '/login');
    return this;
  }
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function registerStudent(client, fields) {
  const fd = new FormData();
  fd.append('_csrf', await client.token('/register'));
  fd.append('consent', 'on');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('id_photo', new Blob([png]), 'id.png');
  const res = await client.req('/register', { method: 'POST', body: fd });
  return { status: res.status, loc: res.headers.get('location'), body: res.status < 300 ? '' : await res.text() };
}

// A coordinator may only register with an invitation, so the tests make one directly in the database.
async function inviteCoordinator(email, name = 'Invited Coordinator') {
  const code = db.newCode(8);
  await db.run("INSERT INTO coordinator_invites (name, email, code_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))", [name, email, await require('bcryptjs').hash(code, 10)]);
  return code;
}
const joinCodeOf = async (admin) => /letter-spacing:\.15em">([A-Z0-9]{8})</.exec((await admin.page('/admin')).body)?.[1];
const groupId = async (admin, name) =>
  new RegExp(`<b>${name}</b>[\\s\\S]*?/admin/groups/(\\d+)`).exec((await admin.page('/admin/groups')).body)?.[1];

(async () => {
  await db.init();
  const one = await new Client().login('admin@school.edu.ph');   // workspace 1 coordinator
  const two = await new Client().login('admin2@school.edu.ph');  // workspace 2 coordinator
  const juan = await new Client().login('juan@student.edu.ph');  // workspace 1 student
  const anna = await new Client().login('anna@student.edu.ph');  // workspace 2 student
  const reyes = await new Client().login('reyes@school.edu.ph'); // workspace 1 adviser
  const nina2 = await new Client().login('adviser2@school.edu.ph'); // workspace 2 adviser

  const g1 = await groupId(one, 'Team Pagasa');
  const g2 = await groupId(two, 'Team Bukid');
  check(!!g1 && !!g2 && g1 !== g2, 'each coordinator lists their own group');

  // ----- lists show only your own workspace -----
  let p = await two.page('/admin/groups');
  check(p.body.includes('Team Bukid') && !p.body.includes('Team Pagasa') && !p.body.includes('Team Aklat'), 'coordinator 2 sees none of workspace 1\'s groups');
  p = await one.page('/admin/groups');
  check(p.body.includes('Team Pagasa') && !p.body.includes('Team Bukid'), 'coordinator 1 sees none of workspace 2\'s groups');
  p = await two.page('/admin/users');
  check(p.body.includes('anna@student.edu.ph') && !p.body.includes('juan@student.edu.ph') && !p.body.includes('reyes@school.edu.ph'), 'coordinator 2\'s user list holds only workspace 2 people');
  p = await one.page('/admin/users');
  check(p.body.includes('juan@student.edu.ph') && !p.body.includes('anna@student.edu.ph') && !p.body.includes('adviser2@school.edu.ph'), 'coordinator 1\'s user list holds only workspace 1 people');
  p = await two.page('/admin/panel');
  check(p.body.includes('Leo Mercado') && !p.body.includes('Elena Cruz'), 'panel lists are separate');
  p = await two.page('/admin/reports.csv');
  check(p.body.includes('Team Bukid') && !p.body.includes('Team Pagasa'), 'the CSV report holds only your own groups');
  p = await two.page('/admin');
  check(!p.body.includes('Team Pagasa') && !p.body.includes('Grace Lim'), 'the overview and recent activity show only your own workspace');
  p = await two.page('/admin/audit');
  check(p.body.includes('BSCS 4B') && !p.body.includes('Team Aklat'), 'the activity log shows only your own workspace');

  // ----- reaching into another workspace by id fails -----
  p = await two.page(`/admin/groups/${g1}`);
  check(p.status === 404, 'coordinator 2 cannot open workspace 1\'s group page');
  await two.post(`/admin/groups/${g1}`, { adviser_id: '', defense_date: '', panel: [] }, '/admin/groups');
  p = await one.page(`/admin/groups/${g1}`);
  check(p.status === 200 && p.body.includes('Team Pagasa'), 'coordinator 2\'s edit of that group did nothing');

  const u1 = (await db.get("SELECT id FROM users WHERE email = 'juan@student.edu.ph'")).id;
  const before = (await db.get('SELECT password_hash FROM users WHERE id = ?', [u1])).password_hash;
  await two.post(`/admin/users/${u1}/reset-password`, {}, '/admin/users');
  await two.post(`/admin/users/${u1}/toggle`, {}, '/admin/users');
  const after = await db.get('SELECT password_hash, active FROM users WHERE id = ?', [u1]);
  check(after.password_hash === before && after.active === 1, 'coordinator 2 cannot reset or deactivate a workspace 1 user');

  // a coordinator cannot give their group an adviser or panel member from another workspace
  const reyesId = (await db.get("SELECT id FROM users WHERE email = 'reyes@school.edu.ph'")).id;
  const cruzId = (await db.get("SELECT id FROM users WHERE email = 'cruz@school.edu.ph'")).id;
  p = await two.post(`/admin/groups/${g2}`, { adviser_id: String(reyesId) }, `/admin/groups/${g2}`);
  check(p.status === 400 && p.body.includes('Pick an active adviser'), 'an adviser from another workspace cannot be assigned');
  p = await two.post(`/admin/groups/${g2}`, { adviser_id: '', panel: [String(cruzId)] }, `/admin/groups/${g2}`);
  check(p.status === 400 && p.body.includes('Choose panel members from the list'), 'a panel member from another workspace cannot be assigned');

  // ----- announcements stay inside the workspace -----
  p = await anna.page('/student');
  check(p.body.includes('Welcome to BSCS 4B') && !p.body.includes('Defense slots are open'), 'a student sees only their own workspace\'s announcements');
  p = await juan.page('/student');
  check(p.body.includes('Defense slots are open') && !p.body.includes('Welcome to BSCS 4B'), 'the other workspace\'s student sees theirs');
  await two.post('/admin/announcements', { title: 'Only for workspace two', body: 'Hello.' }, '/admin/announcements');
  p = await juan.page('/notifications');
  check(!p.body.includes('Only for workspace two'), 'an announcement does not notify the other workspace\'s users');
  p = await anna.page('/notifications');
  check(p.body.includes('Only for workspace two'), 'an announcement does notify the coordinator\'s own users');

  // ----- files and ID photos -----
  const sub1 = await db.get('SELECT s.id FROM submissions s JOIN chapters c ON c.id = s.chapter_id WHERE c.group_id = ? LIMIT 1', [g1]);
  const sub2 = await db.get('SELECT s.id FROM submissions s JOIN chapters c ON c.id = s.chapter_id WHERE c.group_id = ? LIMIT 1', [g2]);
  check((await one.page(`/files/${sub1.id}`)).status === 200, 'a coordinator can download their own workspace\'s file');
  check((await two.page(`/files/${sub1.id}`)).status === 403, 'coordinator 2 cannot download workspace 1\'s file');
  check((await one.page(`/files/${sub2.id}`)).status === 403, 'coordinator 1 cannot download workspace 2\'s file');
  check((await nina2.page(`/files/${sub1.id}`)).status === 403, 'an adviser of workspace 2 cannot download workspace 1\'s file');
  check((await anna.page(`/files/${sub1.id}`)).status === 403, 'a student of workspace 2 cannot download workspace 1\'s file');
  check((await two.page(`/ai/submission/${sub1.id}`)).status === 403, 'AI tools refuse another workspace\'s file');
  check((await reyes.page(`/adviser/group/${g2}`)).status === 403, 'an adviser cannot open a group of another workspace');
  check((await nina2.page(`/adviser/group/${g1}`)).status === 403, 'the other adviser cannot open it either');

  // ----- registration: join codes place people in the right workspace -----
  const code1 = await joinCodeOf(one);
  const code2 = await joinCodeOf(two);
  check(!!code1 && !!code2 && code1 !== code2, 'every workspace has its own join code');
  const stuff = (n) => ({ course: 'IT', year_level: '4', section: '4B', name: `Test Student ${n}`, student_no: `2030-000${n}`, email: `ws-test-${n}-${Date.now()}@student.edu.ph`, password: 'password123', confirm: 'password123' });
  let r = await registerStudent(new Client(), { ...stuff(1), join_code: 'WRONGCOD' });
  check(r.status === 400 && r.body.includes('join code is not valid'), 'a wrong join code is refused');
  r = await registerStudent(new Client(), stuff(2));
  check(r.status === 400 && r.body.includes('join code is not valid'), 'registering without a join code is refused');
  const s3 = stuff(3);
  r = await registerStudent(new Client(), { ...s3, join_code: code2.toLowerCase() });
  check(r.loc === '/student', 'a student registers with workspace 2\'s code (lower case is accepted)');
  check((await two.page('/admin/users')).body.includes(s3.email), 'the new student appears in workspace 2');
  check(!(await one.page('/admin/users')).body.includes(s3.email), 'the new student does not appear in workspace 1');

  // a student cannot add a classmate from another workspace to their group
  const newStudent = await new Client().login(s3.email);
  await newStudent.post('/student/group', { course: 'IT', year_level: '4', section: '4B', name: 'Team Isolation', title: 'Testing', emails: 'juan@student.edu.ph' }, '/student');
  const members = await db.all('SELECT u.email FROM group_members m JOIN users u ON u.id = m.student_id JOIN thesis_groups g ON g.id = m.group_id WHERE g.name = ?', ['Team Isolation']);
  check(members.length === 1 && members[0].email === s3.email, 'a group cannot take members from another workspace');
  check((await db.get("SELECT workspace_id FROM thesis_groups WHERE name = 'Team Isolation'")).workspace_id === (await db.get('SELECT workspace_id FROM users WHERE email = ?', [s3.email])).workspace_id, 'a new group belongs to its creator\'s workspace');

  // ----- a new coordinator gets a brand new, empty workspace -----
  const fresh = new Client();
  const email = `ws-coord-${Date.now()}@school.edu.ph`;
  const invCode = await inviteCoordinator(email, 'Prof. New');
  let cr = await fresh.post('/register/coordinator', { workspace: 'Test Workspace', name: 'Prof. New', email, code: invCode, password: 'password123', confirm: 'password123' }, '/register/coordinator');
  check(cr.status === 400 && cr.body.includes('Privacy Notice'), 'coordinator registration needs the privacy consent');
  cr = await fresh.post('/register/coordinator', { workspace: 'Test Workspace', name: 'Prof. New', email, code: invCode, password: 'password123', confirm: 'password123', consent: 'on' }, '/register/coordinator');
  check(cr.loc === '/admin', 'a teacher registers as a coordinator and lands on the coordinator pages');
  p = await fresh.page('/admin');
  check(p.status === 200 && p.body.includes('Test Workspace') && !p.body.includes('Team Pagasa') && !p.body.includes('Team Bukid'), 'the new workspace starts empty');
  check((await fresh.page('/admin/users')).body.includes(email) && !(await fresh.page('/admin/users')).body.includes('juan@student.edu.ph'), 'the new workspace holds only its coordinator');
  const code3 = await joinCodeOf(fresh);
  check(!!code3 && code3 !== code1 && code3 !== code2, 'the new workspace has its own join code');
  const invCode2 = await inviteCoordinator(email, 'Prof. Dup');
  cr = await new Client().post('/register/coordinator', { workspace: 'Dup', name: 'Dup', email, code: invCode2, password: 'password123', confirm: 'password123', consent: 'on' }, '/register/coordinator');
  check(cr.status === 400 && cr.body.includes('already registered'), 'a coordinator cannot reuse an email');

  // ----- advisers invited by a coordinator join that coordinator's workspace -----
  await fresh.post('/admin/advisers', { name: 'Dr. Invited Here', email: `ws-adv-${Date.now()}@school.edu.ph` }, '/admin/advisers');
  check((await fresh.page('/admin/advisers')).body.includes('ws-adv-') && !(await one.page('/admin/advisers')).body.includes('ws-adv-'), 'an adviser invitation is visible only to the coordinator who sent it');

  // ----- a coordinator can change their own name -----
  const coordName = (await db.get("SELECT name FROM users WHERE email = 'admin2@school.edu.ph'")).name;
  await two.post('/account/name', { name: '  Mr.  Paul   Tan Jr.  ' }, '/account');
  check((await db.get("SELECT name FROM users WHERE email = 'admin2@school.edu.ph'")).name === 'Mr. Paul Tan Jr.', 'a coordinator can edit their own name (extra spaces are tidied)');
  check((await two.page('/admin')).body.includes('Mr. Paul Tan Jr.'), 'the new name shows in the page header');
  await two.post('/account/name', { name: '   ' }, '/account');
  check((await db.get("SELECT name FROM users WHERE email = 'admin2@school.edu.ph'")).name === 'Mr. Paul Tan Jr.', 'an empty name is refused');
  r = await anna.post('/account/name', { name: 'Hacked' }, '/student');
  check(r.status === 403 && (await db.get("SELECT name FROM users WHERE email = 'anna@student.edu.ph'")).name === 'Anna Lopez', 'a student cannot use the coordinator name form');
  check((await two.page('/account')).body.includes('action="/account/name"') && !(await anna.page('/account')).body.includes('action="/account/name"'), 'only the coordinator sees the name form');
  await two.post('/account/name', { name: coordName }, '/account');

  // ----- student home and profile picture -----
  const fsp = require('fs');
  const pathp = require('path');
  const s5 = { course: 'IT', year_level: '4', section: '4B', name: 'Profile Tester', student_no: '2031-0005', email: `ws-test-5-${Date.now()}@student.edu.ph`, password: 'password123', confirm: 'password123' };
  const c5 = new Client();
  r = await registerStudent(c5, { ...s5, join_code: code2 });
  check(r.loc === '/student', 'a new student lands on the student page');
  p = await c5.page('/student');
  check(p.body.includes('Profile Tester') && p.body.includes('2031-0005') && p.body.includes('Create a group') && p.body.includes('Join a group') && !p.body.includes('name="emails"'),
    'the new student sees their name, student ID and the create / join choices instead of a group form');
  check(!(await db.get('SELECT 1 FROM group_members m JOIN users u ON u.id = m.student_id WHERE u.email = ?', [s5.email])), 'registering does not create a group');
  p = await c5.page('/student/group/new');
  check(p.status === 200 && p.body.includes('name="emails"'), 'the create-group form opens from the "Create a group" button');
  const uid5 = (await db.get('SELECT id FROM users WHERE email = ?', [s5.email])).id;
  const sendAvatar = async (client, bytes, filename) => {
    const fd = new FormData();
    fd.append('_csrf', await client.token('/profile'));
    fd.append('avatar', new Blob([bytes]), filename);
    const res = await client.req('/profile/avatar', { method: 'POST', body: fd });
    return res.status;
  };
  const avatarOf = async () => (await db.get('SELECT avatar FROM users WHERE id = ?', [uid5])).avatar;
  const onDisk = (f) => fsp.existsSync(pathp.join(db.UPLOAD_DIR, f));
  check(await avatarOf() === null && (await c5.page('/profile')).body.includes('Upload a profile photo'), 'a new student has no profile photo yet');
  await sendAvatar(c5, png, 'me.png');
  const a1 = await avatarOf();
  check(!!a1 && onDisk(a1), 'a profile photo can be uploaded');
  r = await c5.req(`/avatar/${uid5}`);
  check(r.status === 200 && (r.headers.get('content-type') || '').startsWith('image/'), 'the owner can open their profile photo');
  check((await c5.page('/student')).body.includes(`/avatar/${uid5}?v=`), 'the student page shows the photo');
  await sendAvatar(c5, png, 'again.png');
  const a2 = await avatarOf();
  check(!!a2 && a2 !== a1 && onDisk(a2) && !onDisk(a1), 'replacing the photo removes the old file from the disk');
  await sendAvatar(c5, Buffer.from('this is not an image'), 'fake.png');
  check(await avatarOf() === a2, 'a renamed non-image is refused and the photo is kept');
  await sendAvatar(c5, png, 'notes.txt');
  check(await avatarOf() === a2, 'a file of the wrong type is refused');
  check((await two.req(`/avatar/${uid5}`)).status === 200, 'the coordinator of that workspace can see the photo');
  check((await one.req(`/avatar/${uid5}`)).status === 404, 'a coordinator of another workspace cannot');
  check((await juan.req(`/avatar/${uid5}`)).status === 404, 'a student of another workspace cannot');
  check((await anna.req(`/avatar/${uid5}`)).status === 404, 'a classmate who shares no group cannot');
  check((await new Client().req(`/avatar/${uid5}`)).status === 302, 'a signed-out visitor cannot');
  await c5.post('/profile/avatar/delete', {}, '/profile');
  check(await avatarOf() === null && !onDisk(a2), 'removing the photo clears it and deletes the file');
  check((await c5.req(`/avatar/${uid5}`)).status === 404, 'a removed photo is no longer served');

  // ----- advisers and coordinators have profile pictures too -----
  const idOf = async (email) => (await db.get('SELECT id FROM users WHERE email = ?', [email])).id;
  const reyesUid = await idOf('reyes@school.edu.ph');
  const adminUid = await idOf('admin@school.edu.ph');
  const annaUid = await idOf('anna@student.edu.ph');
  await sendAvatar(reyes, png, 'adviser.png');
  await sendAvatar(one, png, 'coordinator.png');
  await sendAvatar(anna, png, 'anna.png');
  check(!!(await db.get('SELECT avatar FROM users WHERE id = ?', [reyesUid])).avatar && !!(await db.get('SELECT avatar FROM users WHERE id = ?', [adminUid])).avatar, 'an adviser and a coordinator can upload a profile photo');
  p = await reyes.page('/profile');
  check(p.status === 200 && p.body.includes('Adviser') && !p.body.includes('Student ID') && (await one.page('/profile')).body.includes('Edit my name'), 'the profile page is role-aware (no student ID for staff, a name link for the coordinator)');
  const can = async (client, id) => (await client.req(`/avatar/${id}`)).status === 200;
  check(await can(juan, reyesUid) && await can(one, reyesUid), 'an adviser\'s photo is visible to the students and the coordinator of the workspace');
  check(await can(juan, adminUid) && await can(reyes, adminUid), 'the coordinator\'s photo is visible to the students and advisers of the workspace');
  check(!(await can(anna, reyesUid)) && !(await can(two, reyesUid)) && !(await can(anna, adminUid)) && !(await can(nina2, adminUid)), 'staff photos are not visible to other workspaces');
  check(await can(nina2, annaUid) && await can(two, annaUid), 'a student\'s photo is visible to their adviser and their coordinator');
  check(!(await can(reyes, annaUid)) && !(await can(juan, annaUid)), 'but not to an adviser or a student of another workspace');
  const ben2 = await new Client().login('ben@student.edu.ph');
  check(await can(ben2, annaUid), 'and not hidden from a group mate');
  p = await juan.page('/student');
  check(p.body.includes(`/avatar/${reyesUid}?v=`) && p.body.includes(`/avatar/${adminUid}?v=`) && p.body.includes('Coordinator'), 'a student\'s page shows the adviser\'s and the coordinator\'s photos');
  check((await reyes.page('/adviser')).body.includes(`/avatar/${reyesUid}?v=`), 'the top bar shows an adviser\'s own photo');
  check((await one.page('/admin/users')).body.includes(`/avatar/${reyesUid}?v=`), 'the coordinator\'s user list shows photos');

  // ----- deleting a workspace removes only that workspace -----
  const fsx = require('fs');
  const pathx = require('path');
  const st = stuff(4);
  r = await registerStudent(new Client(), { ...st, join_code: code3 });
  const stClient = await new Client().login(st.email);
  await stClient.post('/student/group', { course: 'IT', year_level: '4', section: '4B', name: 'Team Doomed', title: 'Will be deleted' }, '/student');
  const up = new FormData();
  up.append('_csrf', await stClient.token('/student/chapter/1'));
  up.append('file', new Blob(['%PDF-1.4 sample thesis chapter']), 'doomed.pdf');
  await stClient.req('/student/chapter/1/upload', { method: 'POST', body: up });
  const w3 = (await db.get('SELECT id FROM workspaces WHERE join_code = ?', [code3])).id;
  const filesOf = async () => [
    ...(await db.all('SELECT s.stored_name AS f FROM submissions s JOIN chapters c ON c.id = s.chapter_id JOIN thesis_groups g ON g.id = c.group_id WHERE g.workspace_id = ?', [w3])),
    ...(await db.all('SELECT id_photo AS f FROM users WHERE workspace_id = ? AND id_photo IS NOT NULL', [w3])),
  ].map((x) => x.f);
  const doomed = await filesOf();
  check(doomed.length === 2 && doomed.every((f) => fsx.existsSync(pathx.join(db.UPLOAD_DIR, f))), 'the workspace has an uploaded chapter and an ID photo on disk');
  const countOthers = async () => (await db.get('SELECT (SELECT COUNT(*) FROM users WHERE workspace_id != ?) u, (SELECT COUNT(*) FROM thesis_groups WHERE workspace_id != ?) g, (SELECT COUNT(*) FROM submissions) s, (SELECT COUNT(*) FROM announcements WHERE workspace_id != ?) a', [w3, w3, w3]));
  const othersBefore = await countOthers();
  const submissionsBefore = othersBefore.s;

  p = await two.page('/admin/workspace');
  check(p.status === 200 && p.body.includes(code2), 'the workspace page shows the join code');
  const askRows = async () => (await db.get('SELECT COUNT(*) n FROM workspace_deletions WHERE workspace_id = ?', [w3])).n;
  r = await two.post('/admin/workspace/delete-request', { reason: 'x', confirm_name: 'Test Workspace', password: 'password123' }, '/admin/workspace');
  check((await askRows()) === 0 && !!(await db.get('SELECT 1 FROM workspaces WHERE id = ?', [w3])), 'a coordinator cannot ask to delete another workspace by typing someone else\'s name');
  r = await fresh.post('/admin/workspace/delete-request', { reason: 'Closing', confirm_name: 'Wrong name', password: 'password123' }, '/admin/workspace');
  check((await askRows()) === 0, 'a wrong workspace name sends no request');
  r = await fresh.post('/admin/workspace/delete-request', { reason: 'Closing', confirm_name: 'Test Workspace', password: 'wrong-password' }, '/admin/workspace');
  check((await askRows()) === 0, 'a wrong password sends no request');
  r = await fresh.post('/admin/workspace/delete-request', { reason: '', confirm_name: 'Test Workspace', password: 'password123' }, '/admin/workspace');
  check((await askRows()) === 0, 'a request without a reason is refused');
  check((await juan.post('/admin/workspace/delete-request', { reason: 'x', confirm_name: 'x', password: 'x' }, '/student')).status === 403, 'a student cannot reach the request route');
  check((await fresh.post('/admin/workspace/delete', { confirm_name: 'Test Workspace', password: 'password123' }, '/admin/workspace')).status === 404 && !!(await db.get('SELECT 1 FROM workspaces WHERE id = ?', [w3])), 'a coordinator can no longer delete a workspace directly');

  r = await fresh.post('/admin/workspace/delete-request', { reason: 'Course finished', confirm_name: 'Test Workspace', password: 'password123' }, '/admin/workspace');
  check((await askRows()) === 1 && !!(await db.get('SELECT 1 FROM workspaces WHERE id = ?', [w3])), 'a correct request is saved as Pending and deletes nothing');
  await fresh.post('/admin/workspace/delete-request', { reason: 'Again', confirm_name: 'Test Workspace', password: 'password123' }, '/admin/workspace');
  check((await askRows()) === 1, 'a second request is refused while one is pending');
  // The system administrator's delete (same routine) removes everything.
  await require('../wsdelete').deleteWorkspace(w3);
  const left = await db.get('SELECT (SELECT COUNT(*) FROM users WHERE workspace_id = ?) u, (SELECT COUNT(*) FROM thesis_groups WHERE workspace_id = ?) g, (SELECT COUNT(*) FROM announcements WHERE workspace_id = ?) a, (SELECT COUNT(*) FROM activity_log WHERE workspace_id = ?) l, (SELECT COUNT(*) FROM adviser_invites WHERE workspace_id = ?) i, (SELECT COUNT(*) FROM workspaces WHERE id = ?) w', [w3, w3, w3, w3, w3, w3]);
  check(Object.values(left).every((v) => Number(v) === 0), 'every row of the workspace is gone');
  check(doomed.every((f) => !fsx.existsSync(pathx.join(db.UPLOAD_DIR, f))), 'its uploaded files and ID photo are removed from the disk');
  const othersAfter = await countOthers();
  check(JSON.stringify(othersBefore) === JSON.stringify({ ...othersAfter, s: submissionsBefore }) && othersAfter.s === submissionsBefore - 1, 'other workspaces lose nothing');
  check((await db.get('SELECT COUNT(*) n FROM chapters WHERE group_id NOT IN (SELECT id FROM thesis_groups)')).n === 0, 'no orphaned chapters are left behind');
  p = await new Client().post('/login', { email: st.email, password: 'password123' }, '/login');
  check(p.loc === '/login', 'a deleted workspace\'s student can no longer sign in');
  check((await one.page('/admin/groups')).body.includes('Team Pagasa') && (await two.page('/admin/groups')).body.includes('Team Bukid'), 'the other coordinators still see all of their groups');

  await new Promise((r2) => setTimeout(r2, 50));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll workspace isolation checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
