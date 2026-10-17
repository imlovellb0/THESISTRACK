// Deadline reminders. Once an hour (and at start-up) this looks for chapters whose deadline is within 3 days or has passed
// and that are still Not submitted, For revision or Rejected. Each chapter and deadline is reminded once per kind,
// so changing a deadline starts the reminders again for the new date.
const db = require('./db');
const L = require('./lib');

const SOON_DAYS = 3;

async function sendReminders() {
  const rows = await db.all(
    `SELECT c.id, c.number, c.deadline, g.id AS gid, g.name, g.adviser_id
       FROM chapters c JOIN thesis_groups g ON g.id = c.group_id
      WHERE c.deadline IS NOT NULL AND c.status IN ('none', 'revision', 'rejected') AND c.deadline <= ?`,
    [L.addDays(SOON_DAYS)]
  );
  const today = L.today();
  let sent = 0;
  for (const c of rows) {
    const overdue = c.deadline < today;
    const kind = overdue ? 'overdue' : 'soon';
    const r = await db.run('INSERT IGNORE INTO deadline_reminders (chapter_id, kind, deadline) VALUES (?, ?, ?)', [c.id, kind, String(c.deadline).slice(0, 10)]);
    if (!r.changes) continue;
    sent++;
    const link = `/student/chapter/${c.number}`;
    if (overdue) {
      await L.notifyGroup(c.gid, `Chapter ${c.number} was due on ${L.fmtDate(c.deadline)} and is overdue.`, link);
      if (c.adviser_id) await L.notify(c.adviser_id, `${c.name}: Chapter ${c.number} is overdue (due ${L.fmtDate(c.deadline)}).`, `/adviser/group/${c.gid}`);
    } else {
      await L.notifyGroup(c.gid, `Chapter ${c.number} is due on ${L.fmtDate(c.deadline)}.`, link);
    }
  }
  return sent;
}

function startReminders() {
  const run = () => sendReminders().then((n) => n && console.log(`Deadline reminders sent: ${n}.`)).catch((e) => console.error('Reminder check failed:', e.message));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { sendReminders, startReminders };
