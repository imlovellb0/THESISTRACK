// mailer.js - Resend via HTTPS (no SMTP, works on Render free)
const FROM = 'onboarding@resend.dev';

function configured() {
  return !!process.env.RESEND_API_KEY;
}

async function sendMail(toOrOptions, subjectArg, textArg) {
  // Tanggapin pareho: sendMail("email", "subject", "text")
  // at sendMail({ to, subject, text })
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

  // Kung array yung to, kunin yung una
  if (Array.isArray(to)) to = to[0];
  // Kung object pa rin yung to tulad ng { address: ... }, kunin yung address
  if (to && typeof to === 'object') to = to.address || to.email || to.value;

  console.log('[mailer] send called to:', to);
  console.log('[mailer] configured check:', { hasKey: !!process.env.RESEND_API_KEY });

  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is missing');
  }

  console.log('[mailer] connecting to api.resend.com via HTTPS port 443');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: to,
      subject: subject,
      text: text,
      html: html || (text ? text.replace(/\n/g, '<br>') : undefined),
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.log('[mailer] ❌ SMTP FAILED:', data.message || JSON.stringify(data));
    throw new Error(data.message || 'Resend failed');
  }

  console.log('[mailer] ✅ REAL EMAIL SENT via Resend, id:', data.id);
  return { messageId: data.id, ...data };
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