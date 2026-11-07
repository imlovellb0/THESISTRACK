// Checks the student home page, joining with a code, the group leader, leaving, invitations and the student dashboard.
// Use a fresh database: `npm run seed`, then `npm start` in one terminal and `node scripts/group-test.js` in another.
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
  async post(path, fields, tokenPage = '/student') {
    const body = new URLSearchParams({ _csrf: await this.token(tokenPage), ...fields });
    const r = await this.req(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return { status: r.status, loc: r.headers.get('location'), body: r.status >= 300 && r.status < 400 ? '' : await r.text() };
  }
  async login(email) {
    await this.post('/login', { email, password: 'password123' }, '/login');
    return this;
  }
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let seq = 0;
async function register(code, name) {
  seq++;
  const client = new Client();
  const email = `grp-${Date.now()}-${seq}@student.edu.ph`;
  return registerWith(client, code, name, email);
}
async function registerWith(client, code, name, email) {
  seq++;
  const fd = new FormData();
  fd.append('_csrf', await client.token('/register'));
  fd.append('consent', 'on');
  for (const [k, v] of Object.entries({ join_code: code, course: 'IT', year_level: '4', section: '4B', name, student_no: `2040-${Date.now() % 100000}${seq}`.slice(0, 29), email, password: 'password123', confirm: 'password123' })) fd.append(k, v);
  fd.append('id_photo', new Blob([png]), 'id.png');
  const res = await client.req('/register', { method: 'POST', body: fd });
  return { client, email, status: res.status, loc: res.headers.get('location') };
}
const userId = async (email) => (await db.get('SELECT id FROM users WHERE email = ?', [email])).id;
const groupOf = async (email) => db.get('SELECT g.* FROM thesis_groups g JOIN group_members m ON m.group_id = g.id JOIN users u ON u.id = m.student_id WHERE u.email = ?', [email]);
const flash = async (client, path = '/student') => (await client.page(path)).body;

(async () => {
  await db.init();
  const juan = await new Client().login('juan@student.edu.ph');    // leader of Team Pagasa (workspace 1)
  const rico = await new Client().login('rico@student.edu.ph');    // workspace 1, no group yet
  const anna = await new Client().login('anna@student.edu.ph');    // leader of Team Bukid (workspace 2)
  const bea = await new Client().login('bea@student.edu.ph');      // Team Aklat, defense in 10 days
  const admin = await new Client().login('admin@school.edu.ph');
  const pagasa = await groupOf('juan@student.edu.ph');
  const bukid = await groupOf('anna@student.edu.ph');
  const code1 = (await db.get("SELECT join_code FROM workspaces ORDER BY id LIMIT 1")).join_code;
  const code2 = (await db.get("SELECT join_code FROM workspaces ORDER BY id LIMIT 1 OFFSET 1")).join_code;

  // ----- every group has a code and a leader -----
  check(!!pagasa.join_code && /^[A-Z2-9]{6}$/.test(pagasa.join_code) && pagasa.join_code !== bukid.join_code, 'every group has its own 6-character join code');
  check(pagasa.leader_id === await userId('juan@student.edu.ph'), 'the group\'s first member is its leader');

  // ----- the student home page for someone with no group -----
  let p = await rico.page('/student');
  check(p.body.includes('Rico Mangubat') && p.body.includes('2024-0') && p.body.includes('Create a group') && p.body.includes('name="code"') && p.body.includes('Your first steps'), 'a student with no group sees profile, create / join choices and first steps');

  // ----- joining with a code -----
  await rico.post('/student/group/join', { code: 'ZZZZZZ' });
  check(!(await groupOf('rico@student.edu.ph')), 'a wrong code does not join any group');
  await rico.post('/student/group/join', { code: bukid.join_code });
  check(!(await groupOf('rico@student.edu.ph')), 'a code from another workspace does not work');
  p = await rico.page(`/student/join/${pagasa.join_code}`);
  check(p.status === 200 && p.body.includes('Join Team Pagasa') && p.body.includes('Dela Cruz'), 'the invite link shows which group you are about to join and who leads it');
  check((await new Client().page(`/student/join/${pagasa.join_code}`)).loc === '/login', 'the invite link asks a signed-out visitor to sign in first');
  await rico.post('/student/group/join', { code: ` ${pagasa.join_code.toLowerCase().slice(0, 3)}-${pagasa.join_code.slice(3)} ` });
  check((await groupOf('rico@student.edu.ph'))?.id === pagasa.id, 'a student joins with the code (lower case and dashes are accepted)');
  check((await juan.page('/notifications')).body.includes('Rico Mangubat joined Team Pagasa'), 'the group is told when someone joins');
  p = await rico.page('/student');
  check(p.body.includes('Team Pagasa') && p.body.includes('Leader') && !p.body.includes('Group join code'), 'the new member sees the group, but not the leader\'s join code');

  // ----- members cannot manage the group -----
  const maria = await userId('maria@student.edu.ph');
  const ricoId = await userId('rico@student.edu.ph');
  const members = async () => (await db.all('SELECT student_id FROM group_members WHERE group_id = ?', [pagasa.id])).length;
  const before = await members();
  await rico.post('/student/group/members', { email: 'maria@student.edu.ph' });
  await rico.post(`/student/group/members/${maria}/remove`, {});
  await rico.post(`/student/group/members/${ricoId}/leader`, {});
  await rico.post('/student/group/code/new', {});
  const after = await db.get('SELECT leader_id, join_code FROM thesis_groups WHERE id = ?', [pagasa.id]);
  check(await members() === before && after.leader_id === pagasa.leader_id && after.join_code === pagasa.join_code, 'a member cannot add, remove, hand over leadership or change the code');
  check((await flash(rico)).includes('Only the group leader'), 'and is told why');

  // ----- the leader\'s dashboard -----
  p = await juan.page('/student');
  check(p.body.includes('Group join code') && p.body.includes(pagasa.join_code) && p.body.includes(`/student/join/${pagasa.join_code}`) && p.body.includes('Make leader') && p.body.includes('Remove'), 'the leader sees the join code, the invite link and the member controls');

  // ----- pending invitations -----
  const invitee = `grp-invitee-${Date.now()}@student.edu.ph`;
  await juan.post('/student/group/members', { email: invitee });
  check(!!(await db.get('SELECT 1 FROM group_invites WHERE group_id = ? AND email = ?', [pagasa.id, invitee])), 'inviting an email with no account saves a pending invitation');
  check((await juan.page('/student')).body.includes(invitee), 'the leader sees the pending invitation');
  await juan.post('/student/group/members', { email: invitee });
  check((await db.get('SELECT COUNT(*) n FROM group_invites WHERE email = ?', [invitee])).n === 1, 'inviting the same email twice keeps one invitation');
  await juan.post('/student/group/members', { email: 'not-an-email' });
  const reg = await registerWith(new Client(), code1, 'Invited Person', invitee);
  check(reg.loc === '/student' && (await groupOf(invitee))?.id === pagasa.id, 'registering with an invited email joins that group straight away');
  check(!(await db.get('SELECT 1 FROM group_invites WHERE email = ?', [invitee])), 'the invitation is used up');
  p = await reg.client.page('/student');
  check(p.body.includes('Team Pagasa') && p.body.includes('joined it automatically'), 'the new student is told they joined');

  // an invitation does not leak to a person registering in another workspace
  const outsider = `grp-outsider-${Date.now()}@student.edu.ph`;
  await juan.post('/student/group/members', { email: outsider });
  const reg2 = await registerWith(new Client(), code2, 'Outsider', outsider);
  check(reg2.loc === '/student' && !(await groupOf(outsider)), 'an invited email that registers in another workspace does not join');
  await juan.post('/student/group/members', { email: `grp-extra-${Date.now()}@student.edu.ph` });
  check((await db.get('SELECT COUNT(*) n FROM group_members WHERE group_id = ?', [pagasa.id])).n + (await db.get('SELECT COUNT(*) n FROM group_invites WHERE group_id = ?', [pagasa.id])).n === 6, 'the group fills up to 6 people including invitations');
  await juan.post('/student/group/members', { email: `grp-toomany-${Date.now()}@student.edu.ph` });
  check((await flash(juan)).includes('is full'), 'a seventh person is refused');
  const inv = await db.get('SELECT id FROM group_invites WHERE group_id = ? LIMIT 1', [pagasa.id]);
  await rico.post(`/student/group/invites/${inv.id}/cancel`, {});
  check(!!(await db.get('SELECT 1 FROM group_invites WHERE id = ?', [inv.id])), 'a member cannot cancel an invitation');
  await juan.post(`/student/group/invites/${inv.id}/cancel`, {});
  check(!(await db.get('SELECT 1 FROM group_invites WHERE id = ?', [inv.id])), 'the leader can cancel an invitation');

  // ----- regenerating the code -----
  const oldCode = pagasa.join_code;
  await juan.post('/student/group/code/new', {});
  const newCode = (await db.get('SELECT join_code FROM thesis_groups WHERE id = ?', [pagasa.id])).join_code;
  check(newCode !== oldCode, 'the leader can make a new join code');
  const lone = await register(code1, 'Code Tester');
  await lone.client.post('/student/group/join', { code: oldCode });
  check(!(await groupOf(lone.email)), 'the old code stops working');
  await lone.client.post('/student/group/join', { code: newCode });
  check((await groupOf(lone.email))?.id === pagasa.id, 'the new code works');

  // ----- removing a member, handing over, leaving -----
  await juan.post(`/student/group/members/${ricoId}/remove`, {});
  check(!(await groupOf('rico@student.edu.ph')), 'the leader removes a member');
  check((await rico.page('/notifications')).body.includes('removed you from Team Pagasa'), 'the removed member is told');
  check((await rico.page('/student')).body.includes('Create a group'), 'the removed member is back on the create / join page');
  const juanId = await userId('juan@student.edu.ph');
  await juan.post(`/student/group/members/${juanId}/remove`, {});
  check((await groupOf('juan@student.edu.ph'))?.id === pagasa.id, 'the leader cannot remove themselves');
  await juan.post(`/student/group/members/${maria}/leader`, {});
  check((await db.get('SELECT leader_id FROM thesis_groups WHERE id = ?', [pagasa.id])).leader_id === maria, 'the leader hands leadership to another member');
  const memberCountNow = await members();
  await juan.post('/student/group/members', { email: 'rico@student.edu.ph' });
  check(await members() === memberCountNow, 'the former leader can no longer add people');
  const mariaClient = await new Client().login('maria@student.edu.ph');
  await mariaClient.post('/student/group/members', { email: 'rico@student.edu.ph' });
  check((await groupOf('rico@student.edu.ph'))?.id === pagasa.id, 'the new leader adds an existing student by email');
  await juan.post('/student/group/leave', {});
  check(!(await groupOf('juan@student.edu.ph')), 'a member can leave the group');
  await mariaClient.post('/student/group/leave', {});
  check(!(await groupOf('maria@student.edu.ph')), 'the leader can leave too');
  const nextLeader = (await db.get('SELECT leader_id FROM thesis_groups WHERE id = ?', [pagasa.id])).leader_id;
  check(nextLeader !== maria && !!(await db.get('SELECT 1 FROM group_members WHERE group_id = ? AND student_id = ?', [pagasa.id, nextLeader])), 'leadership passed to a member who is still in the group');
  check(!!(await db.get('SELECT 1 FROM chapters WHERE group_id = ?', [pagasa.id])), 'the group and its chapters stay after people leave');

  // the last person cannot leave
  const ben = await new Client().login('ben@student.edu.ph');
  await ben.post('/student/group/leave', {});
  check(!(await groupOf('ben@student.edu.ph')), 'a member of another group can leave');
  await anna.post('/student/group/leave', {});
  check((await groupOf('anna@student.edu.ph'))?.id === bukid.id && (await flash(anna)).includes('only member'), 'the last member cannot leave and is told what to do');

  // ----- creating a group makes you the leader and invites missing people -----
  const creator = await register(code1, 'Group Creator');
  const mate = `grp-mate-${Date.now()}@student.edu.ph`;
  await creator.client.post('/student/group', { course: 'IT', year_level: '4', section: '4B', name: 'Team Fresh', title: 'A new idea', emails: `${mate}, rico@student.edu.ph, juan@student.edu.ph` });
  const fresh = await groupOf(creator.email);
  check(!!fresh && fresh.leader_id === await userId(creator.email) && !!fresh.join_code, 'creating a group makes the student its leader, with a join code');
  check(!!(await db.get('SELECT 1 FROM group_invites WHERE group_id = ? AND email = ?', [fresh.id, mate])), 'an email with no account is invited when the group is created');
  check((await groupOf('juan@student.edu.ph'))?.id === fresh.id, 'an existing student without a group is added by email');
  check((await groupOf('rico@student.edu.ph'))?.id === pagasa.id && (await flash(creator.client)).includes('Skipped'), 'someone who is already in another group is skipped and the leader is told');
  const mateReg = await registerWith(new Client(), code1, 'Mate One', mate);
  check((await groupOf(mate))?.id === fresh.id, 'the invited teammate joins when they register');
  check(!!(await db.get("SELECT 1 FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = ? AND n.message LIKE '%joined Team Fresh from your invitation%'", [creator.email])), 'the leader is told when an invited teammate joins');

  // ----- the student dashboard -----
  const carla = await new Client().login('carla@student.edu.ph');
  p = await carla.page('/student');
  check(p.body.includes('Next up') && p.body.includes('Chapter 3') && p.body.includes('was due'), 'an overdue chapter is shown as the next thing to do');
  const ken = await new Client().login('ken@student.edu.ph');
  p = await ken.page('/student');
  check(p.body.includes('Next up') && p.body.includes('Chapter 1') && p.body.includes('Recent activity') && p.body.includes('First steps'), 'the dashboard has the next-up strip, recent activity and first steps');
  p = await bea.page('/student');
  check(p.body.includes('10 days to go') && p.body.includes('Adviser') && p.body.includes('Book a consultation'), 'the defense countdown and adviser card are shown');
  check(p.body.includes('uploaded Chapter 5 v1') || p.body.includes('uploaded Chapter'), 'the activity feed lists uploads');
  check((await bea.page('/student/chapter/1')).body.includes('What Chapter 1 usually contains') && (await bea.page('/student/chapter/3')).body.includes('Research design'), 'each chapter page has an outline of what it usually contains');
  p = await bea.page('/profile');
  check(p.status === 200 && p.body.includes('Student ID'), 'the profile page opens');
  check((await bea.page('/student/profile')).loc === '/profile', 'the old profile address still works');
  p = await admin.page('/admin/groups/' + pagasa.id);
  check(p.status === 200 && p.body.includes('(leader)'), 'the coordinator\'s group page shows who the leader is');

  // ----- deleting a workspace that has groups with pending invitations -----
  const coord = new Client();
  const cemail = `grp-coord-${Date.now()}@school.edu.ph`;
  const invCode = db.newCode(8);
  await db.run("INSERT INTO coordinator_invites (name, email, code_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))", ['Prof. Gone', cemail, await require('bcryptjs').hash(invCode, 10)]);
  await coord.post('/register/coordinator', { workspace: 'Throwaway', name: 'Prof. Gone', email: cemail, code: invCode, password: 'password123', confirm: 'password123', consent: 'on' }, '/register/coordinator');
  const cCode = /letter-spacing:\.15em">([A-Z0-9]{8})</.exec((await coord.page('/admin')).body)?.[1];
  const ts = await register(cCode, 'Throwaway Student');
  await ts.client.post('/student/group', { course: 'IT', year_level: '4', section: '4B', name: 'Team Gone', title: 'Bye', emails: 'grp-nobody@student.edu.ph' });
  check((await db.get("SELECT COUNT(*) n FROM group_invites WHERE email = 'grp-nobody@student.edu.ph'")).n === 1, 'the throwaway group has a pending invitation');
  await require('../wsdelete').deleteWorkspace((await db.get("SELECT id FROM workspaces WHERE name = 'Throwaway'")).id);
  check(!(await db.get("SELECT 1 FROM workspaces WHERE name = 'Throwaway'")) && (await db.get("SELECT COUNT(*) n FROM group_invites WHERE email = 'grp-nobody@student.edu.ph'")).n === 0, 'deleting a workspace also removes its groups\' invitations');

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll group checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
