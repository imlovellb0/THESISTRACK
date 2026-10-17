// Free backup: dumps the MySQL database and copies the uploads folder into backups/<date>/.
// Run:  npm run backup        Restore the database later with:  mysql -u root thesistrack < backups/<date>/database.sql
require('../loadenv');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB_NAME = process.env.DB_NAME || 'thesistrack';
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', 'uploads');
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const out = path.join(__dirname, '..', 'backups', stamp);
fs.mkdirSync(out, { recursive: true });

// mysqldump is on the PATH on most setups; XAMPP keeps it in its own folder.
const candidates = [process.env.MYSQLDUMP, 'mysqldump', 'C:\\xampp\\mysql\\bin\\mysqldump.exe', '/Applications/XAMPP/xamppfiles/bin/mysqldump'].filter(Boolean);
const args = [
  '-h', process.env.DB_HOST || 'localhost', '-P', String(process.env.DB_PORT || 3306), '-u', process.env.DB_USER || 'root',
  '--single-transaction', '--routines', '--default-character-set=utf8mb4', `--result-file=${path.join(out, 'database.sql')}`, DB_NAME,
];
if (process.env.DB_PASSWORD) args.splice(6, 0, `--password=${process.env.DB_PASSWORD}`);

let ok = false;
for (const bin of candidates) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') continue;
  if (r.status === 0) { ok = true; break; }
  console.error(r.stderr || `mysqldump exited with ${r.status}`);
  break;
}
if (!ok) {
  console.error('The database dump failed. Is MySQL running? If mysqldump is not found, set MYSQLDUMP to its full path (XAMPP: C:\\xampp\\mysql\\bin\\mysqldump.exe).');
  process.exit(1);
}

if (fs.existsSync(UPLOAD_DIR)) fs.cpSync(UPLOAD_DIR, path.join(out, 'uploads'), { recursive: true });
console.log(`Backup saved in ${out}`);
console.log('Copy this folder to a flash drive or a free cloud drive. A backup on the same computer does not survive a dead disk.');
