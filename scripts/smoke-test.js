// End-to-end check of the main workflow against a running server.
// Use a fresh database: `npm run seed`, then `npm start` in one terminal and `npm test` in another.
// Set BASE if the server is not on http://localhost:3000.
const BASE = process.env.BASE || 'http://localhost:3000';
let failed = 0;
const check = (cond, msg) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) failed++;
};
const pad = (n) => String(n).padStart(2, '0');
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    return { status: r.status, body: await r.text(), loc: r.headers.get('location'), type: r.headers.get('content-type') || '' };
  }
  async token(path) {
    const { body } = await this.page(path);
    return /name="_csrf" value="([^"]+)"/.exec(body)?.[1];
  }
  // Fetches a fresh token from tokenPage, then posts the form.
  async post(path, fields, tokenPage) {
    const body = new URLSearchParams({ _csrf: await this.token(tokenPage), ...fields });
    for (const [k, v] of Object.entries(fields)) if (Array.isArray(v)) { body.delete(k); v.forEach((x) => body.append(k, x)); }
    const r = await this.req(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return { status: r.status, loc: r.headers.get('location'), body: r.status >= 300 && r.status < 400 ? '' : await r.text() };
  }
  async upload(path, filename, tokenPage) {
    const fd = new FormData();
    fd.append('_csrf', await this.token(tokenPage));
    fd.append('file', new Blob([filename.endsWith('.docx') ? Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) : '%PDF-1.4 sample thesis chapter'], { type: 'application/octet-stream' }), filename);
    const r = await this.req(path, { method: 'POST', body: fd });
    return { status: r.status, loc: r.headers.get('location') };
  }
  async login(email, password = 'password123') {
    const r = await this.post('/login', { email, password }, '/login');
    return r;
  }
}

(async () => {
  // ----- sign in: the account decides the role; a role sent by the client is ignored -----
  const forged = new Client();
  const fr = await forged.post('/login', { email: 'juan@student.edu.ph', password: 'password123', role: 'admin' }, '/login');
  check(fr.loc === '/student' && (await forged.page('/admin')).status === 403, 'a student who sends role=admin still lands on /student and cannot open /admin');
  for (const [email, home] of [['reyes@school.edu.ph', '/adviser'], ['cruz@school.edu.ph', '/panel'], ['admin@school.edu.ph', '/admin']]) {
    const c = new Client();
    check((await c.login(email)).loc === home, `${email} signs in without choosing a role and lands on ${home}`);
  }
  const bad = new Client();
  let r = await bad.login('juan@student.edu.ph', 'wrong-password');
  check(r.loc === '/login', 'wrong password is refused');

  const juan = new Client();
  r = await juan.login('juan@student.edu.ph');
  check(r.loc === '/student', 'student signs in and lands on /student');
  let p = await juan.page('/student');
  check(p.status === 200 && p.body.includes('Team Pagasa') && p.body.includes('Flood Alert'), 'student dashboard shows the group');

  // ----- csrf and access control -----
  const noToken = await juan.req('/student/consultations', { method: 'POST', body: new URLSearchParams({ topic: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check(noToken.status === 403, 'POST without a CSRF token is refused');
  check((await juan.page('/admin')).status === 403, 'student cannot open the coordinator pages');
  check((await juan.page('/adviser')).status === 403, 'student cannot open the adviser pages');
  check((await juan.page('/files/8')).status === 403, 'student cannot download another group file');
  check((await juan.req('/files/1')).status === 200, 'student can download their own group file');

  // ----- upload rules -----
  await juan.upload('/student/chapter/4/upload', 'virus.exe', '/student/chapter/4');
  p = await juan.page('/student/chapter/4');
  check(p.body.includes('Not submitted'), 'a .exe upload is rejected');

  r = await juan.upload('/student/chapter/4/upload', 'Ch4_Results.pdf', '/student/chapter/4');
  p = await juan.page('/student/chapter/4');
  check(r.status === 302 && p.body.includes('Pending review') && p.body.includes('Ch4_Results.pdf'), 'student uploads Chapter 4 v1 and it goes to Pending review');

  // ----- adviser review -----
  const reyes = new Client();
  await reyes.login('reyes@school.edu.ph');
  p = await reyes.page('/adviser');
  check(p.status === 200 && p.body.includes('Team Pagasa') && p.body.includes('Team Lakbay'), 'adviser sees assigned groups');
  check((await reyes.page('/adviser/group/4')).status === 403, 'adviser cannot open a group assigned to someone else');
  p = await reyes.page('/adviser/group/1/chapter/4');
  check(p.status === 200 && p.body.includes('Ch4_Results.pdf'), 'adviser sees the new submission');

  await reyes.post('/adviser/group/1/chapter/4/review', { decision: 'revision', comment: '' }, '/adviser/group/1/chapter/4');
  p = await reyes.page('/adviser/group/1/chapter/4');
  check(p.body.includes('Pending review'), 'returning without a comment is refused');

  await reyes.post('/adviser/group/1/chapter/4/review', { decision: 'revision', comment: 'Add the data-gathering tables.' }, '/adviser/group/1/chapter/4');
  p = await juan.page('/student/chapter/4');
  check(p.body.includes('For revision') && p.body.includes('Add the data-gathering tables.'), 'student sees the status and the comment');

  const cid = /\/student\/comments\/(\d+)\/resolve/.exec(p.body)?.[1];
  await juan.post(`/student/comments/${cid}/resolve`, {}, '/student/chapter/4');
  p = await juan.page('/student/chapter/4');
  check(p.body.includes('Reopen'), 'student marks feedback resolved');

  r = await juan.upload('/student/chapter/4/upload', 'Ch4_Results_v2.docx', '/student/chapter/4');
  p = await juan.page('/student/chapter/4');
  check(p.body.includes('v2') && p.body.includes('Pending review'), 'student resubmits as version 2');

  await reyes.post('/adviser/group/1/chapter/4/review', { decision: 'approved', comment: '' }, '/adviser/group/1/chapter/4');
  p = await juan.page('/student/chapter/4');
  check(p.body.includes('Approved') && p.body.includes('approved and locked'), 'adviser approves and the chapter locks');

  await reyes.post('/adviser/group/1/chapter/3/deadline', { deadline: inDays(30) }, '/adviser/group/1');
  p = await reyes.page('/adviser/group/1');
  check(p.body.includes(`value="${inDays(30)}"`), 'adviser changes a deadline');

  p = await juan.page('/notifications');
  check(p.body.includes('Chapter 4 was approved'), 'student receives a notification for the approval');

  // ----- consultations -----
  await juan.post('/student/consultations', { date: inDays(5), slot: '13:00', topic: 'Chapter 5 outline' }, '/student');
  p = await reyes.page('/adviser');
  check(p.body.includes('Chapter 5 outline'), 'adviser sees the consultation request');
  const kid = /\/adviser\/consultations\/(\d+)/.exec(p.body)?.[1];
  await reyes.post(`/adviser/consultations/${kid}`, { status: 'Confirmed' }, '/adviser');
  p = await juan.page('/student');
  check(p.body.includes('Confirmed'), 'student sees the confirmed consultation');

  // ----- coordinator -----
  const admin = new Client();
  await admin.login('admin@school.edu.ph');
  for (const url of ['/admin', '/admin/users', '/admin/groups', '/admin/groups/1', '/admin/announcements', '/admin/reports']) {
    check((await admin.page(url)).status === 200, `coordinator opens ${url}`);
  }
  p = await admin.page('/admin/reports.csv');
  check(p.type.startsWith('text/csv') && p.body.includes('Team Pagasa'), 'CSV report downloads');

  r = await admin.post('/admin/groups/1', { adviser_id: '2', panel: ['4'], defense_date: inDays(12), defense_time: '10:00', room: 'IT-101' }, '/admin/groups/1');
  check(r.status === 400 && r.body.includes('at least two'), 'a defense with one panel member is refused');
  r = await admin.post('/admin/groups/1', { adviser_id: '2', panel: ['4', '6'], defense_date: inDays(12), defense_time: '10:00', room: 'IT-101' }, '/admin/groups/1');
  check(r.loc === '/admin/groups', 'coordinator schedules a defense');
  p = await juan.page('/student');
  check(p.body.includes('IT-101'), 'student sees the defense schedule');
  check(!p.body.includes('Elena Cruz'), 'students do not see the panel members');
  check((await reyes.page('/adviser/group/1')).body.includes('IT-101') && !(await reyes.page('/adviser/group/1')).body.includes('Elena Cruz'), 'advisers do not see the panel members');
  check((await admin.page('/admin/groups/1')).body.includes('Elena Cruz'), 'the coordinator sees the panel members');
  r = await new Client().post('/login', { email: 'cruz@school.edu.ph', password: 'password123' }, '/login');
  check(r.loc === '/panel', 'a panel member signs in and lands on /panel');
  r = await admin.post('/admin/users', { name: 'Engr. Panel Added', email: 'panel.added@school.edu.ph', role: 'panel', password: '' }, '/admin/users');
  check(r.loc === '/admin/users' && (await admin.page('/admin/groups/1')).body.includes('Engr. Panel Added'), 'coordinator adds a panel member without a password and can assign them');
  r = await new Client().post('/login', { email: 'panel.added@school.edu.ph', password: '' }, '/login');
  check(r.loc === '/login', 'a panel record that never registered cannot sign in');

  // panel members page: edit, deactivate, remove
  check((await admin.page('/admin/panel')).body.includes('Dr. Elena Cruz'), 'coordinator sees the panel members page');
  check((await admin.post('/admin/panel', { name: 'Dr. New Panelist', email: 'new.panelist@school.edu.ph' }, '/admin/panel')).status === 404, 'the add-a-record-only form is gone; panel members join by invitation');
  p = await admin.page('/admin/panel');
  const pid = new RegExp('id="edit(\\d+)"(?:(?!id="edit)[^])*?value="Engr\\. Panel Added"').exec(p.body)?.[1];
  await admin.post(`/admin/panel/${pid}`, { name: 'Dr. Renamed Panelist', email: 'panel.added@school.edu.ph' }, '/admin/panel');
  check((await admin.page('/admin/panel')).body.includes('Dr. Renamed Panelist'), 'coordinator edits a panel member');
  await admin.post(`/admin/panel/${pid}`, { name: 'Dr. Renamed Panelist', email: 'cruz@school.edu.ph' }, '/admin/panel');
  check((await admin.page('/admin/panel')).body.includes('already used'), 'editing to an email another account uses is refused');
  await admin.post(`/admin/panel/${pid}/toggle`, {}, '/admin/panel');
  check((await admin.page('/admin/panel')).body.includes('Inactive'), 'coordinator deactivates a panel member');
  await admin.post(`/admin/panel/${pid}/delete`, {}, '/admin/panel');
  check(!(await admin.page('/admin/panel')).body.includes(`id="edit${pid}"`), 'coordinator removes a panel member');
  check((await juan.page('/admin/panel')).status === 403, 'students cannot open the panel members page');

  r = await admin.post('/admin/users', { name: 'Dup', email: 'juan@student.edu.ph', role: 'student', password: 'password123' }, '/admin/users');
  check(r.status === 400 && r.body.includes('already registered'), 'duplicate email is refused');
  r = await admin.post('/admin/users', { name: 'Sneaky Adviser', email: 'sneaky@school.edu.ph', role: 'adviser', password: 'password123' }, '/admin/users');
  check(r.status === 400 && r.body.includes('by invitation'), 'the coordinator cannot create an adviser without an invitation');

  // ----- adviser invitation with a one-time code -----
  const fs = require('fs');
  const path = require('path');
  const mailLog = path.join(__dirname, '..', 'outbox', 'mail.log');
  const lastCode = (to) => {
    const blocks = (fs.existsSync(mailLog) ? fs.readFileSync(mailLog, 'utf8') : '').split('--- ').filter((b) => b.includes(`To: ${to}`));
    return /one-time code: (\d{6})/.exec(blocks[blocks.length - 1] || '')?.[1];
  };
  const regAdviser = async (fields) => {
    const c = new Client();
    const res = await c.post('/register/adviser', { confirm: fields.password, ...fields }, '/register/adviser');
    return { c, res };
  };

  r = await admin.post('/admin/advisers', { name: 'Dr. Invited Adviser', email: 'invited.adviser@gmail.com' }, '/admin/advisers');
  check(r.loc === '/admin/advisers' && (await admin.page('/admin/advisers')).body.includes('invited.adviser@gmail.com'), 'coordinator invites an adviser');
  const code = lastCode('invited.adviser@gmail.com');
  check(/^\d{6}$/.test(code || ''), 'the invitation email carries a 6-digit code');
  r = await admin.post('/admin/advisers', { name: 'Dup', email: 'reyes@school.edu.ph' }, '/admin/advisers');
  check(r.status === 400 && r.body.includes('already has an account'), 'inviting an email that already has an account is refused');

  let a = await regAdviser({ email: 'invited.adviser@gmail.com', otp: code === '000000' ? '111111' : '000000', password: 'password123' });
  check(a.res.status === 400 && (await a.c.page('/adviser')).loc === '/login', 'a wrong code does not register the adviser');
  a = await regAdviser({ email: 'someone.else@gmail.com', otp: code, password: 'password123' });
  check(a.res.status === 400 && (await a.c.page('/adviser')).loc === '/login', 'a code does not work for a different email');
  a = await regAdviser({ email: 'invited.adviser@gmail.com', otp: code, password: 'short' });
  check(a.res.status === 400, 'a short password is refused');
  a = await regAdviser({ email: 'invited.adviser@gmail.com', otp: code, password: 'password123' });
  check(a.res.loc === '/adviser' && (await a.c.page('/adviser')).status === 200, 'the invited adviser registers with the code and lands on the adviser pages');
  check((await admin.page('/admin/advisers')).body.includes('Registered'), 'the invitation is marked Registered');
  a = await regAdviser({ email: 'invited.adviser@gmail.com', otp: code, password: 'password123' });
  check(a.res.status === 400, 'a used code cannot be used again');
  const again = new Client();
  r = await again.login('invited.adviser@gmail.com');
  check(r.loc === '/adviser', 'the new adviser can sign in later');

  // resend, cancel, and the attempt limit
  await admin.post('/admin/advisers', { name: 'Dr. Second Adviser', email: 'second.adviser@gmail.com' }, '/admin/advisers');
  const firstCode = lastCode('second.adviser@gmail.com');
  const secondId = new RegExp('Dr\\. Second Adviser[^]*?/admin/advisers/(\\d+)/resend').exec((await admin.page('/admin/advisers')).body)?.[1];
  await admin.post(`/admin/advisers/${secondId}/resend`, {}, '/admin/advisers');
  const newCode = lastCode('second.adviser@gmail.com');
  const wrong = [0, 1, 2, 3, 4].map((i) => String(100000 + i)).filter((x) => x !== newCode);
  for (const w of wrong) await regAdviser({ email: 'second.adviser@gmail.com', otp: w, password: 'password123' });
  a = await regAdviser({ email: 'second.adviser@gmail.com', otp: newCode, password: 'password123' });
  check(a.res.status === 400 && a.res.body.includes('Too many wrong codes'), 'five wrong codes lock the invitation until the coordinator sends a new one');
  await admin.post(`/admin/advisers/${secondId}/resend`, {}, '/admin/advisers');
  a = await regAdviser({ email: 'second.adviser@gmail.com', otp: lastCode('second.adviser@gmail.com'), password: 'password123' });
  check(a.res.loc === '/adviser', 'a new code unlocks the invitation');

  await admin.post('/admin/advisers', { name: 'Dr. Cancelled', email: 'cancelled.adviser@gmail.com' }, '/admin/advisers');
  const cancelCode = lastCode('cancelled.adviser@gmail.com');
  const cancelId = new RegExp('Dr\\. Cancelled[^]*?/admin/advisers/(\\d+)/cancel').exec((await admin.page('/admin/advisers')).body)?.[1];
  await admin.post(`/admin/advisers/${cancelId}/cancel`, {}, '/admin/advisers');
  a = await regAdviser({ email: 'cancelled.adviser@gmail.com', otp: cancelCode, password: 'password123' });
  check(a.res.status === 400, 'a cancelled invitation cannot be used');
  check((await juan.page('/admin/advisers')).status === 403, 'students cannot open the advisers page');
  check(!!firstCode, 'invitation codes are recorded for every invite');

  await admin.post('/admin/announcements', { title: 'Orientation on Friday', body: 'Bring your thesis proposal.' }, '/admin/announcements');
  p = await juan.page('/student');
  check(p.body.includes('Orientation on Friday'), 'announcement shows on the student dashboard');

  // ----- registration and group creation -----
  const fresh = new Client();
  // Students need the coordinator's join code to register.
  const joinCode = /letter-spacing:\.15em">([A-Z0-9]{8})</.exec((await admin.page('/admin')).body)?.[1];
  check(!!joinCode, 'the coordinator overview shows the workspace join code');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const reg = async (client, fields, photo, filename = 'id.png') => {
    const fd = new FormData();
    fd.append('_csrf', await client.token('/register'));
    fd.append('consent', 'on');
    for (const [k, v] of Object.entries({ join_code: joinCode, ...fields })) fd.append(k, v);
    if (photo) fd.append('id_photo', new Blob([photo]), filename);
    const res = await client.req('/register', { method: 'POST', body: fd });
    return { status: res.status, loc: res.headers.get('location'), body: res.status < 300 ? '' : await res.text() };
  };
  const ninaFields = { course: 'IT', year_level: '4', section: '4B', name: 'Nina Ocampo', student_no: '2024-0100', email: 'nina@student.edu.ph', password: 'password123', confirm: 'password123' };
  r = await reg(new Client(), ninaFields, null);
  check(r.status === 400 && r.body.includes('photo of your student ID'), 'registration without an ID photo is refused');
  r = await reg(new Client(), ninaFields, Buffer.from('not an image at all'), 'fake.jpg');
  check(r.status === 400 && r.body.includes('not a valid image'), 'a renamed non-image is refused as the ID photo');
  r = await reg(new Client(), { ...ninaFields, student_no: '2024-0001' }, png);
  check(r.status === 400 && r.body.includes('student ID number is already registered'), 'a duplicate student ID number is refused');
  r = await reg(fresh, ninaFields, png);
  check(r.loc === '/student', 'new student registers with a student ID number and an ID photo');
  p = await admin.page('/admin/users');
  const photoId = /\/id-photo\/(\d+)/.exec(p.body)?.[1];
  check(p.body.includes('2024-0100') && !!photoId, 'coordinator sees the student ID number and photo link');
  r = await admin.req(`/id-photo/${photoId}`);
  check(r.status === 200 && (r.headers.get('content-type') || '').startsWith('image/'), 'coordinator opens the ID photo');
  check((await fresh.req(`/id-photo/${photoId}`)).status === 200, 'a student can open their own ID photo');
  check((await juan.page(`/id-photo/${photoId}`)).status === 403, 'another student cannot open the ID photo');
  check((await new Client().page(`/id-photo/${photoId}`)).loc === '/login', 'a signed-out visitor cannot open the ID photo');
  p = await fresh.page('/student');
  check(p.body.includes('Nina Ocampo') && p.body.includes('2024-0100') && p.body.includes('Create a group'), 'new student sees their profile and the choice to create or join a group');
  await fresh.post('/student/group', { course: 'IT', year_level: '4', section: '4B', name: 'Team Bagwis', title: 'Campus Lost and Found Portal', emails: 'rico@student.edu.ph, juan@student.edu.ph' }, '/student');
  p = await fresh.page('/student');
  check(p.body.includes('Team Bagwis') && p.body.includes('Rico Mangubat') && !p.body.includes('Juan Dela Cruz'), 'group is created; members already in a group are skipped');

  const bagwisId = /<b>Team Bagwis<\/b>[\s\S]*?\/admin\/groups\/(\d+)/.exec((await admin.page('/admin/groups')).body)?.[1];
  check(!!bagwisId, 'the new group appears on the coordinator\'s group list');

  // ----- adviser assignment needs the adviser's approval -----
  const santos = new Client();
  await santos.login('santos@school.edu.ph');
  await admin.post(`/admin/groups/${bagwisId}`, { adviser_id: '3' }, `/admin/groups/${bagwisId}`);
  p = await fresh.page('/student');
  check(p.body.includes('waiting for them to accept'), 'a requested adviser is not assigned until they accept');
  p = await santos.page('/adviser');
  check(p.body.includes('Advisory requests') && p.body.includes('Team Bagwis'), 'adviser sees the advisory request');
  const rid = /\/adviser\/assignments\/(\d+)/.exec(p.body)?.[1];
  await reyes.post(`/adviser/assignments/${rid}`, { decision: 'accept' }, '/adviser');
  check((await santos.page('/adviser')).body.includes('Team Bagwis'), 'another adviser cannot answer the request');
  await santos.post(`/adviser/assignments/${rid}`, { decision: 'decline', reason: '' }, '/adviser');
  check((await santos.page('/adviser')).body.includes('Advisory requests'), 'declining without a reason is refused');
  await santos.post(`/adviser/assignments/${rid}`, { decision: 'decline', reason: 'I already advise too many groups.' }, '/adviser');
  p = await admin.page(`/admin/groups/${bagwisId}`);
  check(p.body.includes('Declined') && p.body.includes('I already advise too many groups.'), 'coordinator sees the decline and the reason');
  check(p.body.includes('Choose another adviser') && p.body.includes('declined this group'), 'coordinator is told to pick another adviser');
  check((await admin.page('/admin/groups')).body.includes('declined'), 'groups list shows the declined request');
  check((await admin.page('/notifications')).body.includes('I already advise too many groups.'), 'coordinator is notified with the reason');
  check((await fresh.page('/student')).body.includes('not assigned yet'), 'student still has no adviser after a decline');
  await admin.post(`/admin/groups/${bagwisId}`, { adviser_id: '3' }, `/admin/groups/${bagwisId}`);
  p = await santos.page('/adviser');
  await santos.post(`/adviser/assignments/${/\/adviser\/assignments\/(\d+)/.exec(p.body)?.[1]}`, { decision: 'accept' }, '/adviser');
  check((await santos.page(`/adviser/group/${bagwisId}`)).status === 200, 'accepted adviser can open the group');
  check((await fresh.page('/student')).body.includes('Prof. Ramon Santos'), 'student sees the adviser after acceptance');

  // ----- privacy, password reset, activity log, notifications -----
  check((await new Client().page('/privacy')).body.includes('Privacy Notice'), 'the privacy notice is public');
  const noConsent = new Client();
  const fdc = new FormData();
  fdc.append('_csrf', await noConsent.token('/register'));
  for (const [k, v] of Object.entries({ join_code: joinCode, course: 'IT', year_level: '4', section: '4B', name: 'Zed Cruz', student_no: '2024-0777', email: 'zed@student.edu.ph', password: 'password123', confirm: 'password123' })) fdc.append(k, v);
  fdc.append('id_photo', new Blob([png]), 'id.png');
  const rc = await noConsent.req('/register', { method: 'POST', body: fdc });
  check(rc.status === 400 && (await rc.text()).includes('Privacy Notice'), 'registration without agreeing to the privacy notice is refused');

  const forgetful = new Client();
  const mailBefore = fs.existsSync(mailLog) ? fs.readFileSync(mailLog, 'utf8').length : 0;
  r = await forgetful.post('/forgot', { email: 'juan@student.edu.ph' }, '/forgot');
  check(r.status === 200 && r.body.includes('reset link was created'), 'forgot password answers the same way for a real email');
  r = await new Client().post('/forgot', { email: 'nobody@nowhere.test' }, '/forgot');
  check(r.status === 200 && r.body.includes('reset link was created'), 'forgot password does not reveal unknown emails');
  const mailNew = fs.readFileSync(mailLog, 'utf8').slice(mailBefore);
  const tok = /\/reset\/([0-9a-f]{64})/.exec(mailNew)?.[1];
  check(!!tok && !mailNew.includes('nobody@nowhere.test'), 'only the registered email gets a reset link');
  check((await forgetful.page('/reset/' + tok)).status === 200, 'the reset link opens');
  check((await forgetful.page('/reset/' + 'a'.repeat(64))).status === 400, 'a made-up reset link is refused');
  r = await forgetful.post('/reset/' + tok, { password: 'short', confirm: 'short' }, '/reset/' + tok);
  check(r.status === 400, 'a short new password is refused on reset');
  r = await forgetful.post('/reset/' + tok, { password: 'newpassword1', confirm: 'newpassword1' }, '/reset/' + tok);
  check(r.loc === '/login', 'the reset link sets a new password');
  check((await forgetful.page('/reset/' + tok)).status === 400, 'a reset link works only once');
  r = await new Client().login('juan@student.edu.ph', 'newpassword1');
  check(r.loc === '/student', 'the student signs in with the new password');
  r = await new Client().login('juan@student.edu.ph', 'password123');
  check(r.loc === '/login', 'the old password no longer works');

  p = await admin.page('/admin/audit?q=reset');
  check(p.status === 200 && p.body.includes('reset their password'), 'the coordinator activity log shows and filters records');
  check((await admin.page('/admin/audit.csv')).type.includes('text/csv'), 'the activity log downloads as CSV');
  check((await fresh.page('/admin/audit')).status === 403, 'students cannot open the activity log');

  p = await admin.page('/notifications');
  check(!p.body.includes('/delete') && !p.body.includes('/notifications/clear'), 'notifications cannot be deleted or cleared');

  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
