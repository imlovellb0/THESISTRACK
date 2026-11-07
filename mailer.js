const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

function configured() {
  const ok = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  console.log('[mailer] configured check:', { host: !!process.env.SMTP_HOST, user: !!process.env.SMTP_USER, pass: !!process.env.SMTP_PASS, userValue: process.env.SMTP_USER ? process.env.SMTP_USER.slice(0,3) + '***' : null });
  return ok;
}

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// Tumatanggap ng DALAWANG klase ng tawag:
// 1. send({ to, subject, text }) - ito yung ginagamit ng admin.js mo
// 2. send('email@gmail.com', 'subject', 'text') - pang-backup
async function send(toOrObj, subjectOrText, textArg) {
  let to, subject, text;

  if (typeof toOrObj === 'object' && toOrObj !== null) {
    to = toOrObj.to || toOrObj.email;
    subject = toOrObj.subject;
    text = toOrObj.text || toOrObj.html;
  } else {
    to = toOrObj;
    subject = subjectOrText;
    text = textArg;
  }

  console.log('[mailer] send called to:', to);

  if (!configured()) {
    // Fallback: save sa mail.log para hindi mawala yung code
    try {
      const dir = path.join(__dirname, 'outbox');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'mail.log'), `\n[${new Date().toISOString()}] TO: ${to} | ${subject} | ${text}\n`);
    } catch (e) {}
    console.log('[mailer] NOT CONFIGURED - saved to outbox/mail.log');
    return { sent: false, reason: 'not-configured' };
  }

  try {
    const info = await getTransporter().sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
    console.log('[mailer] ✅ REAL EMAIL SENT to', to, info.messageId);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.log('[mailer] ❌ SMTP FAILED:', err.message);
    return { sent: false, error: err.message };
  }
}

// Para sa kahit anong tawag: sendInvite({name,email}, otp) O sendInvite(name,email,otp) O sendInvite(invite, otp)
async function sendInvite(a, b, c) {
  if (typeof a === 'object' && a !== null && b !== undefined && typeof b !== 'string') {
    // sendInvite({name,email}, otp) - galing sa admin.js
    const invite = a;
    const otp = b;
    return send({
      to: invite.email,
      subject: 'Your ThesisTrack adviser invitation',
      text: `Hello ${invite.name},\n\nYour one-time code: ${otp}\n\nEnter this code to set up your adviser account.\n\n- ThesisTrack`
    });
  }
  if (typeof a === 'object' && a !== null) {
    // sendInvite(invite, otp) - resend
    return send({
      to: a.email,
      subject: 'Your ThesisTrack adviser invitation',
      text: `Hello ${a.name},\n\nYour one-time code: ${b}\n\n- ThesisTrack`
    });
  }
  // sendInvite(name, email, otp)
  return send({
    to: b,
    subject: 'Your ThesisTrack adviser invitation',
    text: `Hello ${a},\n\nYour one-time code: ${c}\n\n- ThesisTrack`
  });
}

async function sendOTP(email, otp) {
  return send(email, 'Your ThesisTrack OTP', `Your OTP code is: ${otp}`);
}

module.exports = { send, sendInvite, sendOTP, configured };