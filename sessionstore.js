// Keeps login sessions in MySQL, so they survive a server restart and work if the app runs more than once.
const session = require('express-session');
const db = require('./db');

class MySQLStore extends session.Store {
  constructor(ttlMs) {
    super();
    this.ttl = ttlMs;
    setInterval(() => db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()]).catch(() => {}), 15 * 60 * 1000).unref();
  }
  get(sid, cb) {
    db.get('SELECT data FROM sessions WHERE sid = ? AND expires > ?', [sid, Date.now()])
      .then((row) => cb(null, row ? JSON.parse(row.data) : null))
      .catch(cb);
  }
  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttl;
    db.run('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), expires = VALUES(expires)', [sid, JSON.stringify(sess), expires])
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttl;
    db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [expires, sid])
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
  destroy(sid, cb) {
    db.run('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
}

module.exports = MySQLStore;
