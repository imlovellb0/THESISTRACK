// Connects to MySQL (XAMPP) and creates the database and every table the system needs.
// Connection settings come from environment variables. The defaults match a fresh XAMPP install.
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs = require('fs');

// Set UPLOAD_DIR to a persistent disk path when hosting (the default is the uploads folder in the project).
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  // Managed MySQL services usually require TLS. DB_SSL=true turns it on; DB_SSL=insecure skips certificate checks.
  ssl: process.env.DB_SSL ? { rejectUnauthorized: process.env.DB_SSL !== 'insecure' } : undefined,
};
const DB_NAME = process.env.DB_NAME || 'thesistrack';

let pool;
// Inside db.transaction(), every query automatically uses that transaction's connection.
const txStore = new AsyncLocalStorage();
const runner = () => txStore.getStore() || pool;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS sessions (
    sid     VARCHAR(128) NOT NULL PRIMARY KEY,
    data    MEDIUMTEXT NOT NULL,
    expires BIGINT NOT NULL,
    INDEX (expires)
  )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(120) NOT NULL,
    join_code  VARCHAR(12) NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    name  VARCHAR(60) NOT NULL PRIMARY KEY,
    value VARCHAR(255) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    email         VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          ENUM('student','adviser','panel','admin','superadmin') NOT NULL,
    active        INT NOT NULL DEFAULT 1,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    student_no    VARCHAR(30) NULL UNIQUE,
    id_photo      VARCHAR(100) NULL
  )`,
  `CREATE TABLE IF NOT EXISTS thesis_groups (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    title         TEXT NOT NULL,
    adviser_id    INT NULL,
    defense_date  DATE NULL,
    defense_time  VARCHAR(5) NULL,
    room          VARCHAR(60) NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (adviser_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS adviser_invites (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(190) NOT NULL,
    role       ENUM('adviser') NOT NULL DEFAULT 'adviser',
    status     ENUM('Invited','Registered','Cancelled') NOT NULL DEFAULT 'Invited',
    otp_hash   VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempts   INT NOT NULL DEFAULT 0,
    invited_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    used_at    DATETIME NULL,
    INDEX (email),
    FOREIGN KEY (invited_by) REFERENCES users(id)
  )`,
  // The system administrator invites each new coordinator. The code is single-use, tied to one email, and stored hashed.
  `CREATE TABLE IF NOT EXISTS coordinator_invites (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(190) NOT NULL,
    status     ENUM('Invited','Registered','Cancelled') NOT NULL DEFAULT 'Invited',
    code_hash  VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempts   INT NOT NULL DEFAULT 0,
    invited_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    used_at    DATETIME NULL,
    INDEX (email),
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_invites (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    group_id   INT NOT NULL,
    email      VARCHAR(190) NOT NULL,
    invited_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY one_invite (group_id, email),
    INDEX (email),
    FOREIGN KEY (group_id) REFERENCES thesis_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS adviser_requests (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    group_id   INT NOT NULL,
    adviser_id INT NOT NULL,
    status     ENUM('Pending','Accepted','Declined','Cancelled') NOT NULL DEFAULT 'Pending',
    reason     TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME NULL,
    FOREIGN KEY (group_id) REFERENCES thesis_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (adviser_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS group_members (
    group_id   INT NOT NULL,
    student_id INT NOT NULL UNIQUE,
    PRIMARY KEY (group_id, student_id),
    FOREIGN KEY (group_id) REFERENCES thesis_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS group_panelists (
    group_id INT NOT NULL,
    panel_id INT NOT NULL,
    PRIMARY KEY (group_id, panel_id),
    FOREIGN KEY (group_id) REFERENCES thesis_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (panel_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS chapters (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    group_id  INT NOT NULL,
    number    INT NOT NULL,
    status    ENUM('none','submitted','revision','approved','rejected') NOT NULL DEFAULT 'none',
    deadline  DATE NULL,
    UNIQUE (group_id, number),
    FOREIGN KEY (group_id) REFERENCES thesis_groups(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS submissions (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    chapter_id    INT NOT NULL,
    version_no    INT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name   VARCHAR(100) NOT NULL,
    uploaded_by   INT NULL,
    uploaded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chapter_id, version_no),
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    chapter_id INT NOT NULL,
    author_id  INT NOT NULL,
    body       TEXT NOT NULL,
    resolved   INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS consultations (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    group_id   INT NOT NULL,
    adviser_id INT NOT NULL,
    date       DATE NOT NULL,
    slot       VARCHAR(5) NOT NULL,
    topic      VARCHAR(200) NOT NULL,
    status     ENUM('Requested','Confirmed','Declined') NOT NULL DEFAULT 'Requested',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES thesis_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (adviser_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS announcements (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    title      VARCHAR(120) NOT NULL,
    body       TEXT NOT NULL,
    posted_by  INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (posted_by) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    user_id    INT NOT NULL,
    message    TEXT NOT NULL,
    link       VARCHAR(255) NULL,
    is_read    INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS submission_text (
    submission_id INT PRIMARY KEY,
    body          MEDIUMTEXT NOT NULL,
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS activity_log (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    actor_id   INT NULL,
    action     TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS password_resets (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    user_id    INT NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at    DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (token_hash),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  // Messages: one thread per thesis group (members, adviser, coordinator) and one private thread per student or adviser with the coordinator.
  `CREATE TABLE IF NOT EXISTS conversations (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT NOT NULL,
    kind         ENUM('group','direct') NOT NULL,
    group_id     INT NULL,
    user_id      INT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_at      DATETIME NULL,
    UNIQUE KEY one_per_group (group_id),
    UNIQUE KEY one_per_user (user_id),
    INDEX (workspace_id),
    FOREIGN KEY (group_id) REFERENCES thesis_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    sender_id       INT NULL,
    body            TEXT NOT NULL,
    hidden          INT NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (conversation_id, id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_reads (
    conversation_id INT NOT NULL,
    user_id         INT NOT NULL,
    last_read       INT NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS deadline_reminders (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    chapter_id INT NOT NULL,
    kind       VARCHAR(10) NOT NULL,
    deadline   VARCHAR(10) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY one_per_deadline (chapter_id, kind, deadline),
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
  )`,
];

// Creates the database and tables if they are missing. Pass { reset: true } to wipe the database first.
async function init({ reset = false } = {}) {
  let admin;
  try {
    admin = await mysql.createConnection(CONFIG);
  } catch (e) {
    throw new Error(
      `Cannot connect to MySQL at ${CONFIG.host}:${CONFIG.port} as "${CONFIG.user}" (${e.code || e.message}). ` +
        'Start MySQL in the XAMPP Control Panel, or set DB_HOST, DB_PORT, DB_USER and DB_PASSWORD.'
    );
  }
  if (reset) await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  pool = mysql.createPool({
    ...CONFIG,
    database: DB_NAME,
    charset: 'utf8mb4',
    connectionLimit: 10,
    dateStrings: true, // dates come back as 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS' text, which the app expects
  });
  for (const sql of TABLES) await pool.query(sql);

  // Databases created before these columns existed get them added here.
  await addColumnIfMissing('users', 'student_no', 'VARCHAR(30) NULL UNIQUE');
  await addColumnIfMissing('users', 'id_photo', 'VARCHAR(100) NULL');
  await addColumnIfMissing('users', 'consent_at', 'DATETIME NULL');
  await addColumnIfMissing('users', 'avatar', 'VARCHAR(100) NULL');
  // Groups have a join code and a leader. Members remember when they joined (used to pick the next leader).
  if (await addColumnIfMissing('thesis_groups', 'join_code', 'VARCHAR(10) NULL')) await pool.query('ALTER TABLE thesis_groups ADD UNIQUE (join_code)');
  await addColumnIfMissing('thesis_groups', 'leader_id', 'INT NULL');
  await addColumnIfMissing('group_members', 'joined_at', 'DATETIME NULL DEFAULT CURRENT_TIMESTAMP');
  // The system administrator role sits above every workspace. Its account has no workspace.
  await pool.query("ALTER TABLE users MODIFY role ENUM('student','adviser','panel','admin','superadmin') NOT NULL");
  await addColumnIfMissing('workspaces', 'active', 'INT NOT NULL DEFAULT 1');
  await addColumnIfMissing('announcements', 'broadcast_id', 'VARCHAR(16) NULL');
  await backfillGroups();
  await migrateWorkspaces();
  if (await addColumnIfMissing('notifications', 'source', "VARCHAR(12) NOT NULL DEFAULT 'system'")) await backfillNotificationSource();
}

// Every coordinator has a workspace. The people, groups, announcements, invitations and activity log of one workspace
// are invisible to every other workspace. Data created before workspaces existed moves into one "Default workspace".
const WORKSPACE_TABLES = ['users', 'thesis_groups', 'announcements', 'adviser_invites', 'activity_log'];

async function migrateWorkspaces() {
  const added = [];
  for (const t of WORKSPACE_TABLES) if (await addColumnIfMissing(t, 'workspace_id', 'INT NULL')) added.push(t);
  for (const t of added) await pool.query(`ALTER TABLE \`${t}\` ADD INDEX (workspace_id)`);
  if (!added.length) return;
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  if (!n) return;
  const [[old]] = await pool.query('SELECT id FROM workspaces ORDER BY id LIMIT 1');
  const wid = old ? old.id : (await pool.query('INSERT INTO workspaces (name, join_code) VALUES (?, ?)', ['Default workspace', newJoinCode()]))[0].insertId;
  for (const t of WORKSPACE_TABLES) await pool.query(`UPDATE \`${t}\` SET workspace_id = ? WHERE workspace_id IS NULL`, [wid]);
}

// Join codes are typed by hand, so they avoid look-alike characters (0/O, 1/I).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = (length) => Array.from({ length }, () => CODE_CHARS[require('crypto').randomInt(CODE_CHARS.length)]).join('');
const newJoinCode = () => newCode(8); // workspaces

// A group join code that no other group uses.
async function uniqueGroupCode() {
  for (;;) {
    const code = newCode(6);
    if (!(await get('SELECT 1 FROM thesis_groups WHERE join_code = ?', [code]))) return code;
  }
}

// Groups made before join codes and leaders existed get both. The first member (lowest id) becomes the leader.
async function backfillGroups() {
  for (const g of await all('SELECT id FROM thesis_groups WHERE join_code IS NULL')) {
    await run('UPDATE thesis_groups SET join_code = ? WHERE id = ?', [await uniqueGroupCode(), g.id]);
  }
  await pool.query('UPDATE thesis_groups g SET leader_id = (SELECT MIN(m.student_id) FROM group_members m WHERE m.group_id = g.id) WHERE leader_id IS NULL');
}

// Creates a workspace with a fresh unique join code. Returns { id, join_code }.
async function createWorkspace(name) {
  for (;;) {
    const code = newJoinCode();
    try {
      const r = await run('INSERT INTO workspaces (name, join_code) VALUES (?, ?)', [name, code]);
      return { id: r.lastInsertRowid, join_code: code };
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
}

async function addColumnIfMissing(table, column, definition) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [DB_NAME, table, column]
  );
  if (rows.length) return false;
  await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  return true;
}

// Notifications saved before the source column existed are sorted by their wording.
async function backfillNotificationSource() {
  const groups = {
    adviser: ['Chapter % was % by %', '% commented on Chapter %', 'New deadline for Chapter %', 'Your consultation on %', '% accepted and is now your adviser.', '% accepted the advisory for %', '% declined the advisory for %'],
    coordinator: ['The coordinator reset your password.%', '% asks you to be their adviser.%', 'Defense for %', 'New announcement: %'],
    student: ['% added you to %', '% submitted Chapter %', '% requested a consultation on %'],
  };
  for (const [source, patterns] of Object.entries(groups)) {
    for (const pattern of patterns) await pool.query('UPDATE notifications SET source = ? WHERE message LIKE ?', [source, pattern]);
  }
}

const all = async (sql, params = []) => (await runner().query(sql, params))[0];
const get = async (sql, params = []) => (await all(sql, params))[0];
const run = async (sql, params = []) => {
  const [r] = await runner().query(sql, params);
  return { lastInsertRowid: r.insertId, changes: r.affectedRows };
};

// Runs fn inside one transaction. Everything it awaits shares the same connection, and any error rolls it back.
async function transaction(fn) {
  if (txStore.getStore()) return fn(); // already inside a transaction
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await txStore.run(conn, fn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// System-wide switches the system administrator controls. A missing setting reads as its default.
const getSetting = async (name, fallback) => (await get('SELECT value FROM settings WHERE name = ?', [name]))?.value ?? fallback;
const setSetting = (name, value) => run('INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, String(value)]);

const ping = async () => { await pool.query('SELECT 1'); };

module.exports = { init, ping, all, get, run, transaction, getSetting, setSetting, newCode, newJoinCode, createWorkspace, uniqueGroupCode, UPLOAD_DIR, DB_NAME };
