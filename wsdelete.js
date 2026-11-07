// Permanently deletes one workspace and everything in it. Used by the coordinator (own workspace) and the system administrator.
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function deleteWorkspace(wid) {
  // File names are collected first and removed from the disk only after the database delete has succeeded.
  const stored = [
    ...(await db.all('SELECT s.stored_name AS f FROM submissions s JOIN chapters c ON c.id = s.chapter_id JOIN thesis_groups g ON g.id = c.group_id WHERE g.workspace_id = ?', [wid])),
    ...(await db.all('SELECT id_photo AS f FROM users WHERE workspace_id = ? AND id_photo IS NOT NULL', [wid])),
    ...(await db.all('SELECT avatar AS f FROM users WHERE workspace_id = ? AND avatar IS NOT NULL', [wid])),
    ...(await db.all('SELECT m.file_stored AS f FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.workspace_id = ? AND m.file_stored IS NOT NULL', [wid])),
  ].map((r) => r.f);

  await db.transaction(async () => {
    // Groups first: their chapters, versions, comments, consultations, members, panel links and adviser requests go with them.
    await db.run('DELETE FROM conversations WHERE workspace_id = ?', [wid]); // their messages and read marks go with them
    await db.run('DELETE FROM thesis_groups WHERE workspace_id = ?', [wid]);
    for (const t of ['adviser_invites', 'panel_invites', 'announcements', 'activity_log']) await db.run(`DELETE FROM ${t} WHERE workspace_id = ?`, [wid]);
    await db.run('DELETE FROM users WHERE workspace_id = ?', [wid]); // notifications and reset links go with the users
    await db.run('DELETE FROM workspaces WHERE id = ?', [wid]);
  });
  for (const f of stored) fs.rmSync(path.join(db.UPLOAD_DIR, path.basename(f)), { force: true });
}

module.exports = { deleteWorkspace };
