// Small security helpers shared by the routes.
const db = require('./db');

const PROD = process.env.NODE_ENV === 'production';
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', '12345678', '123456789', '1234567890', 'qwerty123',
  'qwertyuiop', 'iloveyou', 'admin123', 'welcome1', 'welcome123', 'letmein123', 'abc12345', '11111111', '00000000',
  'thesistrack', 'thesis123', 'student123', 'adviser123', 'changeme', 'p@ssw0rd', 'passw0rd',
]);

// Returns a message when the password is too easy to guess, otherwise null. Sample data uses password123, so this only applies on the live site.
function weakPassword(password, email = '') {
  if (!PROD) return null;
  const p = String(password).toLowerCase();
  if (COMMON.has(p) || /^(.)\1+$/.test(p)) return 'That password is too common. Choose something harder to guess.';
  const local = String(email).toLowerCase().split('@')[0];
  if (local.length >= 4 && p.includes(local)) return 'Do not use your email name inside your password.';
  return null;
}

// Signs a user out everywhere, optionally keeping the session they are using right now.
async function endSessions(userId, keepSid = null) {
  const like = [`%"userId":${Number(userId)},%`, `%"userId":${Number(userId)}}%`];
  if (keepSid) await db.run('DELETE FROM sessions WHERE (data LIKE ? OR data LIKE ?) AND sid != ?', [...like, keepSid]);
  else await db.run('DELETE FROM sessions WHERE data LIKE ? OR data LIKE ?', like);
}

// In-memory counter: allows `max` hits per `windowMs` for a key, then answers true (blocked).
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.since > windowMs) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.since > windowMs) { hits.set(key, { n: 1, since: now }); return false; }
    return ++h.n > max;
  };
}

module.exports = { weakPassword, endSessions, limiter };
