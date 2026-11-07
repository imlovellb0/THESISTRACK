// mailer.js - Brevo via HTTPS (no SMTP, works on Render free, any recipient)
const FROM_EMAIL = 'lovelybillones417@gmail.com';
const FROM_NAME = 'ThesisTrack';

function configured() {
  return !!process.env.BREVO_API_KEY;
}

async function sendMail(toOrOptions, subjectArg, textArg) {
  let to, subject, text, html;

  if (toOrOptions && typeof toOrOptions === 'object') {
    to = toOrOptions.to;
    subject = toOrOptions.subject;
    text = toOrOptions.text;
    html = toOrOptions.html;
  } else {
    to = toOrOptions;
    subject = subjectArg;
    text = textArg;
  }

  if (Array.isArray(to)) to = to[0];
  if (to && typeof to === 'object') to = to.address || to.email || to.value;

  console.log('[mailer] send called to:', to);
  console.log('[mailer] configured check:', { hasKey: !!process.env.BREVO_API_KEY });

  if (!process.env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is missing');
  }

  console.log('[mailer] connecting to api.brevo.com via HTTPS port 443');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: to }],
      subject: subject,
      textContent: text,
      htmlContent: html || (text ? text.replace(/\n/g, '<br>') : undefined),
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.log('[mailer] ❌ BREVO FAILED:', data.message || JSON.stringify(data));
    throw new Error(data.message || 'Brevo failed');
  }

  console.log('[mailer] ✅ REAL EMAIL SENT via Brevo, id:', data.messageId);
  return { messageId: data.messageId, ...data };
}

async function sendInvite(to, code, link) {
  const subject = 'Your ThesisTrack coordinator invitation';
  const text = `Hello,\n\nYour invitation code: ${code}\n\nTo finish, open: ${link}\n\nIf you did not expect this, ignore this email.\n`;
  return sendMail(to, subject, text);
}

module.exports = {
  sendMail,
  send: sendMail,
  sendInvite,
  sendInvitation: sendInvite,
  configured,
  isConfigured: configured,
  getTransporter: () => ({ sendMail }),
};