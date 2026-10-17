require('./loadenv');
// Fills an empty database with sample accounts, groups and chapters so the system is not blank on first run.
// Run `npm run seed` to wipe everything and start again.
const fs = require('fs');
const path = require('path');

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');
const L = require('./lib');

const PASSWORD = 'password123';

async function seedIfEmpty() {
  if ((await db.get('SELECT COUNT(*) AS n FROM users')).n > 0) return false;
  const hash = bcrypt.hashSync(PASSWORD, 10);
  const ws = await db.createWorkspace('BSIT 4A Thesis (sample)');
  const ws2 = await db.createWorkspace('BSCS 4B Thesis (sample)');

  const uid = {};
  const people = [
    ['admin', 'Ms. Grace Lim', 'admin@school.edu.ph', 'admin'],
    ['reyes', 'Dr. Lourdes Reyes', 'reyes@school.edu.ph', 'adviser'],
    ['santos', 'Prof. Ramon Santos', 'santos@school.edu.ph', 'adviser'],
    ['cruz', 'Dr. Elena Cruz', 'cruz@school.edu.ph', 'panel'],
    ['villanueva', 'Engr. Mark Villanueva', 'villanueva@school.edu.ph', 'panel'],
    ['dizon', 'Prof. Ana Dizon', 'dizon@school.edu.ph', 'panel'],
    ['juan', 'Juan Dela Cruz', 'juan@student.edu.ph', 'student'],
    ['maria', 'Maria Santos', 'maria@student.edu.ph', 'student'],
    ['paolo', 'Paolo Garcia', 'paolo@student.edu.ph', 'student'],
    ['carla', 'Carla Mendoza', 'carla@student.edu.ph', 'student'],
    ['diego', 'Diego Ramos', 'diego@student.edu.ph', 'student'],
    ['bea', 'Bea Fernandez', 'bea@student.edu.ph', 'student'],
    ['luis', 'Luis Navarro', 'luis@student.edu.ph', 'student'],
    ['tina', 'Tina Aquino', 'tina@student.edu.ph', 'student'],
    ['ken', 'Ken Villar', 'ken@student.edu.ph', 'student'],
    ['joy', 'Joy Bautista', 'joy@student.edu.ph', 'student'],
    ['rico', 'Rico Mangubat', 'rico@student.edu.ph', 'student'], // no group yet, to try group creation
  ];
  let studentNo = 0;
  for (const [key, name, email, role] of people) {
    const no = role === 'student' ? `2024-${String(++studentNo).padStart(4, '0')}` : null;
    uid[key] = (await db.run('INSERT INTO users (name, email, password_hash, role, student_no, workspace_id) VALUES (?, ?, ?, ?, ?, ?)', [name, email, hash, role, no, ws.id])).lastInsertRowid;
  }

  const addGroup = (...a) => db.run('INSERT INTO thesis_groups (name, title, adviser_id, defense_date, defense_time, room, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [...a, ws.id]);
  const addMember = (...a) => db.run('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', a);
  const addPanel = (...a) => db.run('INSERT INTO group_panelists (group_id, panel_id) VALUES (?, ?)', a);
  const setChapter = (...a) => db.run('UPDATE chapters SET status = ?, deadline = ? WHERE group_id = ? AND number = ?', a);
  const chapterId = (...a) => db.get('SELECT id FROM chapters WHERE group_id = ? AND number = ?', a);
  const addSub = (...a) => db.run('INSERT INTO submissions (chapter_id, version_no, original_name, stored_name, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)', a);
  const addComment = (...a) => db.run('INSERT INTO comments (chapter_id, author_id, body, resolved, created_at) VALUES (?, ?, ?, ?, ?)', a);

  // Seeded files are small text placeholders so the Download buttons work.
  const placeholder = (label) => {
    const stored = crypto.randomUUID() + '.txt';
    fs.writeFileSync(path.join(db.UPLOAD_DIR, stored), `Sample placeholder for ${label}.\nReal uploads are PDF or Word files.\n`);
    return stored;
  };

  // spec: [group key, name, title, adviser, panel keys, members, defense, chapters]
  // chapter spec: [status, deadline offset in days, [[file label, uploaded offset in days], ...]]
  const specs = [
    ['Team Pagasa', 'Barangay Flood Alert System with SMS Notification', 'reyes', ['cruz', 'dizon'], ['juan', 'maria', 'paolo'], null, [
      ['approved', -35, [['Ch1_Introduction_v1', -42], ['Ch1_Introduction_v2', -33]]],
      ['revision', 4, [['Ch2_RRL_v1', -10]]],
      ['submitted', 14, [['Ch3_Methodology_v1', -1]]],
      ['none', 35], ['none', 56]]],
    ['Team Lakbay', 'Mobile Tricycle Booking App for Local Commuters', 'reyes', ['villanueva', 'dizon'], ['carla', 'diego'], null, [
      ['approved', -50, [['Ch1_v1', -55]]], ['approved', -25, [['Ch2_v1', -30]]],
      ['revision', -5, [['Ch3_v1', -12]]], ['none', 30], ['none', 50]]],
    ['Team Aklat', 'Library Seat Reservation and Attendance System', 'reyes', ['cruz', 'villanueva', 'dizon'], ['bea', 'luis', 'tina'], [10, '14:00', 'IT-204'], [
      ['approved', -80, [['Ch1_v1', -85]]], ['approved', -60, [['Ch2_v1', -65]]], ['approved', -40, [['Ch3_v1', -45]]],
      ['approved', -14, [['Ch4_v1', -20]]], ['submitted', 7, [['Ch5_v1', -2]]]]],
    ['Team Tala', 'Online Enrollment Assistant Chatbot', 'santos', ['villanueva', 'dizon'], ['ken', 'joy'], null, [
      ['none', -6], ['none', 20], ['none', 40], ['none', 60], ['none', 80]]],
  ];

  const gid = {};
  for (const [name, title, adviser, panel, members, defense, chs] of specs) {
    const id = (await addGroup(name, title, uid[adviser], defense ? L.addDays(defense[0]) : null, defense ? defense[1] : null, defense ? defense[2] : null)).lastInsertRowid;
    gid[name] = id;
    await db.run('UPDATE thesis_groups SET leader_id = ?, join_code = ? WHERE id = ?', [uid[members[0]], await db.uniqueGroupCode(), id]);
    for (const m of members) await addMember(id, uid[m]);
    for (const p of panel) await addPanel(id, uid[p]);
    await L.createChapters(id);
    for (const [i, [status, off, files]] of chs.entries()) {
      await setChapter(status, L.addDays(off), id, i + 1);
      const cid = (await chapterId(id, i + 1)).id;
      for (const [v, [label, upOff]] of (files || []).entries()) {
        await addSub(cid, v + 1, `${label}.txt`, placeholder(`${name} ${label}`), uid[members[0]], L.addDays(upOff) + ' 10:00:00');
      }
    }
  }

  const c = async (name, n) => (await chapterId(gid[name], n)).id;
  await addComment(await c('Team Pagasa', 1), uid.reyes, 'Rewrite the scope and limitations as two separate sections.', 1, L.addDays(-40) + ' 09:00:00');
  await addComment(await c('Team Pagasa', 1), uid.reyes, 'Objectives are specific and measurable now. Good revision.', 1, L.addDays(-33) + ' 15:30:00');
  await addComment(await c('Team Pagasa', 2), uid.reyes, 'Add at least five studies published within the last five years.', 0, L.addDays(-8) + ' 11:00:00');
  await addComment(await c('Team Pagasa', 2), uid.reyes, 'The synthesis table has no gap statement. State what your system adds.', 0, L.addDays(-8) + ' 11:05:00');
  await addComment(await c('Team Lakbay', 3), uid.reyes, 'The sampling method is unclear. How many respondents, and why that number?', 0, L.addDays(-9) + ' 14:20:00');

  const addConsult = (...a) => db.run('INSERT INTO consultations (group_id, adviser_id, date, slot, topic, status) VALUES (?, ?, ?, ?, ?, ?)', a);
  await addConsult(gid['Team Pagasa'], uid.reyes, L.addDays(2), '10:00', 'Chapter 2 revisions', 'Confirmed');
  await addConsult(gid['Team Lakbay'], uid.reyes, L.addDays(3), '14:00', 'Sampling for Chapter 3', 'Requested');

  const addNotice = (...a) => db.run('INSERT INTO announcements (title, body, posted_by, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)', a.length === 5 ? a : [...a, ws.id]);
  await addNotice('Chapter 3 deadline is three weeks from now', 'The coordinator extended the Methodology deadline by one week for all groups.', uid.admin, L.addDays(-1) + ' 08:00:00');
  await addNotice('Defense slots are open', 'Groups with an approved Chapter 4 may ask the coordinator for a defense slot.', uid.admin, L.addDays(-4) + ' 08:00:00');

  await L.log(uid.reyes, 'commented on Team Pagasa, Chapter 2');
  await L.log(uid.bea, 'submitted Chapter 5 v1 for Team Aklat');
  await L.log(uid.admin, 'scheduled the defense for Team Aklat');

  // A second, separate coordinator. Signing in as admin2@school.edu.ph shows none of the data above, which demonstrates workspace isolation.
  const other = {};
  for (const [key, name, email, role] of [
    ['admin2', 'Mr. Paul Tan', 'admin2@school.edu.ph', 'admin'],
    ['adviser2', 'Dr. Nina Flores', 'adviser2@school.edu.ph', 'adviser'],
    ['panel2', 'Prof. Leo Mercado', 'panel2@school.edu.ph', 'panel'],
    ['anna', 'Anna Lopez', 'anna@student.edu.ph', 'student'],
    ['ben', 'Ben Castillo', 'ben@student.edu.ph', 'student'],
  ]) {
    const no = role === 'student' ? `2025-${String(++studentNo).padStart(4, '0')}` : null;
    other[key] = (await db.run('INSERT INTO users (name, email, password_hash, role, student_no, workspace_id) VALUES (?, ?, ?, ?, ?, ?)', [name, email, hash, role, no, ws2.id])).lastInsertRowid;
  }
  const g2 = (await db.run('INSERT INTO thesis_groups (name, title, adviser_id, workspace_id) VALUES (?, ?, ?, ?)',
    ['Team Bukid', 'Crop Disease Detection Using a Phone Camera', other.adviser2, ws2.id])).lastInsertRowid;
  await db.run('UPDATE thesis_groups SET leader_id = ?, join_code = ? WHERE id = ?', [other.anna, await db.uniqueGroupCode(), g2]);
  await addMember(g2, other.anna);
  await addMember(g2, other.ben);
  await addPanel(g2, other.panel2);
  await L.createChapters(g2);
  await setChapter('submitted', L.addDays(10), g2, 1);
  await addSub((await chapterId(g2, 1)).id, 1, 'Ch1_v1.txt', placeholder('Team Bukid Ch1_v1'), other.anna, L.addDays(-1) + ' 10:00:00');
  await addNotice('Welcome to BSCS 4B', 'Submit Chapter 1 before the deadline.', other.admin2, L.addDays(-2) + ' 08:00:00', ws2.id);
  await L.log(other.admin2, 'created the workspace BSCS 4B Thesis (sample)');
  return true;
}

module.exports = { seedIfEmpty, PASSWORD };

if (require.main === module) {
  (async () => {
    try {
      if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run the sample-data seed with NODE_ENV=production.');
      const reset = process.argv.includes('--reset');
      if (reset) {
        // Delete uploaded files, then drop and recreate the whole database.
        for (const f of fs.readdirSync(db.UPLOAD_DIR)) if (f !== '.gitkeep') fs.rmSync(path.join(db.UPLOAD_DIR, f), { force: true });
      }
      await db.init({ reset });
      const done = await seedIfEmpty();
      console.log(done ? `Sample data created. Every account uses the password "${PASSWORD}".` : 'Database already has users. Run `npm run seed` to reset it.');
      process.exit(0);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  })();
}
