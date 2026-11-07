// Sends email. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (and optionally MAIL_FROM) to send real mail.
// Without those settings, messages are written to outbox/mail.log instead of being sent.
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const OUTBOX = path.join(__dirname, 'outbox');

const getEnv = (key) => {
  const v = process.env[key];
  if (!v) return '';
  return v.trim().replace(/\s+/g, ''); // tanggalin spaces sa App Password
};

const configured = () => {
  const host = getEnv('SMTP_HOST');
  const user = getEnv('SMTP_USER');
  const pass = getEnv('SMTP_PASS');
  console.log('[mailer] configured check:', {
    host: !!host,
    user: !!user,
    pass: !!pass,
    userValue: user ? user.slice(0, 3) + '***' : '(empty)'
  });
  return !!(host && user && pass);
};

let transport;

async function send(to, subject, text) {
  if (configured()) {
    const port = Number(process.env.SMTP_PORT || 465);
    if (!transport) {
      transport = nodemailer.createTransport({
        host: getEnv('SMTP_HOST'),
        port,
        secure: port === 465,
        auth: { user: getEnv('SMTP_USER'), pass: getEnv('SMTP_PASS') },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 12000,
      });
    }
    try {
      const from = (process.env.MAIL_FROM || '').trim() || getEnv('SMTP_USER');
      await transport.sendMail({ from, to, subject, text });
      console.log(`[mailer] ✅ REAL EMAIL SENT to ${to}`);
      return { sent: true };
    } catch (err) {
      console.log(`[mailer] ❌ SMTP FAILED: ${err.message}`);
      // Huwag mag-fallback sa file pag nag-fail sa Render, para makita mo yung error
      throw err;
    }
  }

  fs.mkdirSync(OUTBOX, { recursive: true });
  fs.appendFileSync(path.join(OUTBOX, 'mail.log'), `--- ${new Date().toISOString()}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n\n`);
  console.log(`Email is not set up. The message to ${to} was saved in outbox/mail.log.`);
  return { sent: false };
}

async function sendInvite(name, email, otp) {
  const subject = 'Your ThesisTrack Invite Code';
  const text = `Hi ${name},\n\nYour ThesisTrack invite code is: ${otp}\n\nEnter this code to set up your adviser account.\n\n- ThesisTrack`;
  return send(email, subject, text);
}

async function sendOTP(email, otp) {
  return send(email, 'Your ThesisTrack OTP', `Your OTP code is: ${otp}`);
}

module.exports = { send, sendInvite, sendOTP, configured };