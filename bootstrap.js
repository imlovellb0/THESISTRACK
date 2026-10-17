// First start of a live site: no sample data. If there is no coordinator yet, create one from ADMIN_EMAIL,
// ADMIN_PASSWORD and ADMIN_NAME. Change the password after the first sign-in.
const bcrypt = require('bcryptjs');
const db = require('./db');

async function ensureAdmin() {
  if (await db.get("SELECT 1 FROM users WHERE role = 'admin'")) return false;
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.ADMIN_NAME || 'Thesis Coordinator').trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10) {
    console.warn('No coordinator account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 10 characters) and restart to create one.');
    return false;
  }
  const ws = await db.createWorkspace(`${name}'s workspace`);
  await db.run("INSERT INTO users (name, email, password_hash, role, workspace_id) VALUES (?, ?, ?, 'admin', ?)", [name, email, bcrypt.hashSync(password, 10), ws.id]);
  console.log(`Coordinator account created for ${email}. Remove ADMIN_PASSWORD from the settings now.`);
  return true;
}

// The system administrator has no workspace and manages the whole site. On the live site it is created from
// SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD and SUPERADMIN_NAME. On a development machine a sample account is made.
async function ensureSuperAdmin() {
  if (await db.get("SELECT 1 FROM users WHERE role = 'superadmin'")) return false;
  const prod = process.env.NODE_ENV === 'production';
  const email = String(process.env.SUPERADMIN_EMAIL || (prod ? '' : 'system@school.edu.ph')).trim().toLowerCase();
  const password = String(process.env.SUPERADMIN_PASSWORD || (prod ? '' : 'password123'));
  const name = String(process.env.SUPERADMIN_NAME || 'System Administrator').trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || (prod && password.length < 10)) {
    console.warn('No system administrator exists. Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (at least 10 characters) and restart to create one.');
    return false;
  }
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) {
    console.warn(`Cannot create the system administrator: ${email} already belongs to another account.`);
    return false;
  }
  await db.run("INSERT INTO users (name, email, password_hash, role, consent_at) VALUES (?, ?, ?, 'superadmin', NOW())", [name, email, bcrypt.hashSync(password, 10)]);
  console.log(`System administrator account created for ${email}.${prod ? ' Remove SUPERADMIN_PASSWORD from the settings now.' : ''}`);
  return true;
}

module.exports = { ensureAdmin, ensureSuperAdmin };
