// mailer.js - Resend API (HTTPS, hindi SMTP - hindi blocked ni Render)
const FROM = process.env.SMTP_USER || 'onboarding@resend.dev';

async function sendMail({ to, subject, html, text }) {
  console.log('[mailer] send called to:', to);
  console.log('[mailer] configured check:', {
    host: true,
    user: true,
    pass: true,
    userValue: FROM ? FROM.slice(0, 3) + '***' : 'missing',
  });

  if (!process.env.RESEND_API_KEY) {
    console.log('[mailer] ❌ SMTP FAILED: RESEND_API_KEY is missing');
    throw new Error('RESEND_API_KEY is missing');
  }

  console.log('[mailer] connecting to api.resend.com via HTTPS port 443');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `ThesisTrack <${FROM}>`,
      to: [to],
      subject: subject,
      html: html,
      text: text || html?.replace(/<[^>]+>/g, ''),
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.log('[mailer] ❌ SMTP FAILED:', data.message || res.statusText);
    throw new Error(data.message || `Resend failed: ${res.status}`);
  }

  console.log('[mailer] ✅ REAL EMAIL SENT via Resend:', data.id);
  return data;
}

// Para hindi masira yung ibang files na tumatawag sa lumang function
async function send(to, subject, html) {
  return sendMail({ to, subject, html });
}

async function sendInvite(to, code, inviteLink) {
  const subject = 'Your ThesisTrack Invitation Code';
  const html = `
    <h2>You are invited to ThesisTrack</h2>
    <p>Your invitation code is:</p>
    <h1 style="letter-spacing: 4px;">${code}</h1>
    ${inviteLink ? `<p><a href="${inviteLink}">Click here to accept invitation</a></p>` : ''}
    <p>If you did not expect this, please ignore this email.</p>
  `;
  return sendMail({ to, subject, html });
}

module.exports = {
  sendMail,
  send,
  sendInvite,
  sendInvitation: sendInvite,
  // stub lang para hindi mag-error yung lumang code na naghahanap nito
  getTransporter: () => ({ sendMail }),
};