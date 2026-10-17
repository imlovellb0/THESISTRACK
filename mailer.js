// Sends email. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (and optionally MAIL_FROM) to send real mail.
// For Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=your address, SMTP_PASS=an App Password.
// Without those settings, messages are written to outbox/mail.log in the project folder instead of being sent.
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const OUTBOX = path.join(__dirname, 'outbox');
const configured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transport;
async function send({ to, subject, text }) {
  if (configured()) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport ||= nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Give up quickly when there is no internet, so the page does not hang during a demo.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
    });
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  }
  fs.mkdirSync(OUTBOX, { recursive: true });
  fs.appendFileSync(path.join(OUTBOX, 'mail.log'), `--- ${new Date().toISOString()}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n\n`);
  console.log(`Email is not set up. The message to ${to} was saved in outbox/mail.log.`);
  return { sent: false };
}

module.exports = { send, configured };
