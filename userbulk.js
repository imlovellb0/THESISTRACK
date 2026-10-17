// Activate, deactivate or remove several accounts at once. Used by the coordinator (own workspace) and the system administrator.
// The route decides which users may be touched at all; this file decides what happens to each one.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const L = require('./lib');

// Removing an account is only allowed when no thesis work hangs on it. Anyone else should be deactivated instead.
async function blocker(u) {
  const has = async (sql) => !!(await db.get(sql, [u.id]));
  if (u.role === 'student' && await has('SELECT 1 FROM group_members WHERE student_id = ?')) return 'is in a group';
  if (u.role === 'adviser' && await has('SELECT 1 FROM thesis_groups WHERE adviser_id = ?')) return 'advises a group';
  if (u.role === 'adviser' && await has('SELECT 1 FROM consultations WHERE adviser_id = ?')) return 'has consultations';
  if (await has('SELECT 1 FROM comments WHERE author_id = ?')) return 'wrote comments';
  if (await has('SELECT 1 FROM submissions WHERE uploaded_by = ?')) return 'uploaded files';
  return null;
}

async function removeOne(u) {
  await db.transaction(async () => {
    await db.run('DELETE FROM group_panelists WHERE panel_id = ?', [u.id]);
    await db.run('DELETE FROM adviser_requests WHERE adviser_id = ?', [u.id]);
    for (const [t, c] of [['group_invites', 'invited_by'], ['adviser_invites', 'invited_by'], ['announcements', 'posted_by'], ['activity_log', 'actor_id']]) {
      await db.run(`UPDATE ${t} SET ${c} = NULL WHERE ${c} = ?`, [u.id]); // the record stays, without a name
    }
    await db.run('DELETE FROM users WHERE id = ?', [u.id]); // notifications and reset links go with the user
  });
  for (const f of [u.id_photo, u.avatar]) if (f) fs.rmSync(path.join(db.UPLOAD_DIR, path.basename(f)), { force: true });
}

// action: 'activate' | 'deactivate' | 'remove'. Returns { done, skipped: ['Name (reason)'] }.
async function applyBulk(action, users, actor, { removeCoordinators = false } = {}) {
  let done = 0;
  const skipped = [];
  const names = [];
  for (const u of users) {
    if (u.id === actor.id) { skipped.push(`${u.name} (your own account)`); continue; }
    if (action === 'remove') {
      if (u.role === 'admin' && !removeCoordinators) { skipped.push(`${u.name} (only the system administrator removes coordinators)`); continue; }
      const why = await blocker(u);
      if (why) { skipped.push(`${u.name} (${why}; deactivate instead)`); continue; }
      await removeOne(u);
    } else {
      const want = action === 'activate' ? 1 : 0;
      if (u.active === want) continue;
      await db.run('UPDATE users SET active = ? WHERE id = ?', [want, u.id]);
    }
    done++;
    names.push(u.name);
  }
  if (done) await L.log(actor.id, `${action === 'remove' ? 'removed' : action === 'activate' ? 'activated' : 'deactivated'} ${done} account${done === 1 ? '' : 's'}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ' and others' : ''}`);
  return { done, skipped };
}

// The message the page shows afterwards.
function summary(action, { done, skipped }) {
  const verb = action === 'remove' ? 'Removed' : action === 'activate' ? 'Activated' : 'Deactivated';
  const head = done ? `${verb} ${done} account${done === 1 ? '' : 's'}.` : 'Nothing was changed.';
  return head + (skipped.length ? ` Skipped: ${skipped.join('; ')}.` : '');
}

module.exports = { applyBulk, summary };
