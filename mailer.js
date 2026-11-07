// mailer.js - Brevo via HTTPS
const FROM_EMAIL = 'lovelybillones417@gmail.com';
const FROM_NAME = 'ThesisTrack';

// FIXED - ONLY THIS LINK, WALANG ?code=, WALANG DAGDAG
const LOGIN_URL = 'https://thesistrack-ikda.onrender.com/login';

function configured() { return !!process.env.BREVO_API_KEY; }

async function sendMail(toOrOptions, subjectArg, textArg) {
  let to, subject, text, html;
  if (toOrOptions && typeof toOrOptions === 'object') {
    to = toOrOptions.to; subject = toOrOptions.subject; text = toOrOptions.text; html = toOrOptions.html;
  } else { to = toOrOptions; subject = subjectArg; text = textArg; }
  if (Array.isArray(to)) to = to[0];
  if (to && typeof to === 'object') to = to.address || to.email || to.value;
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is missing');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html || (text ? text.replace(/\n/g, '<br>') : undefined),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Brevo failed');
  return { messageId: data.messageId, ...data };
}

async function sendInvite(to, code, link) {
  // I-IGNORE kahit anong link ang ipasa - LAGING LOGIN_URL LANG
  const finalLink = LOGIN_URL;
  const subject = 'Your ThesisTrack Invitation Code';
  const text = `Hello,\n\nYou have been invited to ThesisTrack.\n\nYour OTP / Invitation Code: ${code}\n\nClick here to login:\n${finalLink}\n\nEnter your code on the login page to continue.\nThis code is for you only. 1 time use only, expires in 7 days.\n\nIf you did not expect this, ignore this email.\n`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background: #f9fafb; border-radius: 12px;">
      <h2 style="color: #1e2a4a;">ThesisTrack</h2>
      <p>You have been invited to ThesisTrack.</p>
      <p>Your OTP / Invitation Code:</p>
      <div style="background: #1e2a4a; color: #fff; font-size: 28px; font-weight: 800; letter-spacing: 4px; text-align: center; padding: 16px; border-radius: 10px; margin: 16px 0;">${code}</div>
      <p style="color: #6b7280; font-size: 13px; text-align: center;">For you only. 1 time use only, expires in 7 days.</p>
      <a href="${finalLink}" style="display: block; text-align: center; background: #1e2a4a; color: #fff; padding: 14px; border-radius: 10px; text-decoration: none; font-weight: 700; margin-top: 20px;">Click Here to Login</a>
      <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 16px;">${finalLink}</p>
    </div>`;
  return sendMail({ to, subject, text, html });
}

module.exports = { sendMail, send: sendMail, sendInvite, sendInvitation: sendInvite, configured, isConfigured: configured, getTransporter: () => ({ sendMail }), LOGIN_URL };