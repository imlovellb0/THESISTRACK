// AI helpers for every signed-in role: plagiarism check, grammar suggestions and the chatbot.
const router = require('express').Router();
const PART_WORDS = 1200;
const db = require('../db');
const L = require('../lib');
const ai = require('../ai');
const plagiarism = require('../plagiarism');
const { textOf, ExtractError } = require('../textextract');
const { requireLogin } = require('../middleware');

router.use(requireLogin);

// The free AI services have daily limits, so each person gets a fair share per hour.
const used = new Map();
function allow(userId, kind, max) {
  const key = `${userId}:${kind}`;
  const now = Date.now();
  const recent = (used.get(key) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= max) { used.set(key, recent); return false; }
  recent.push(now);
  used.set(key, recent);
  return true;
}

// ---------- tools for one uploaded version ----------
async function loadSubmission(req, res) {
  const sub = await db.get(
    `SELECT s.*, c.group_id, c.number AS chapter_no, g.name AS group_name FROM submissions s
       JOIN chapters c ON c.id = s.chapter_id JOIN thesis_groups g ON g.id = c.group_id WHERE s.id = ?`,
    [Number(req.params.id)]
  );
  if (!sub || !(await L.canAccessGroup(req.user, sub.group_id))) {
    res.status(403).render('error', { title: 'No access', message: 'You cannot open this file.' });
    return null;
  }
  return sub;
}
const page = (res, sub, extra = {}) =>
  res.render('ai-tools', { title: 'AI check', sub, aiOn: !!ai.provider(), showNames: res.locals.user.role !== 'student', ...extra });

router.get('/submission/:id', async (req, res) => {
  const sub = await loadSubmission(req, res);
  if (!sub) return;
  let parts = 0;
  try { parts = Math.ceil((await textOf(sub)).split(/\s+/).length / PART_WORDS); } catch (e) { /* the buttons still work and explain the problem */ }
  page(res, sub, { parts });
});

router.post('/submission/:id/plagiarism', async (req, res) => {
  const sub = await loadSubmission(req, res);
  if (!sub) return;
  if (!allow(req.user.id, 'plag', 20)) return page(res, sub, { error: 'You have run many checks this hour. Try again later.' });
  try {
    const plag = await plagiarism.check(sub, sub.group_id);
    await L.log(req.user.id, `ran a similarity check on ${sub.group_name} Chapter ${sub.chapter_no} v${sub.version_no}`);
    page(res, sub, { plag });
  } catch (e) {
    if (!(e instanceof ExtractError)) throw e;
    page(res, sub, { error: e.message });
  }
});

const GRAMMAR_SYSTEM =
  'You are a careful proofreader for an undergraduate thesis written in English. Find grammar, spelling, punctuation, ' +
  'word-choice and clarity problems in the text. Do not rewrite the whole text and do not change the meaning or technical terms. ' +
  'Return ONLY JSON of the form {"issues":[{"original":"exact short phrase from the text","suggestion":"corrected phrase","reason":"short explanation"}]} ' +
  'with at most 15 of the most important issues, most serious first. If the text is fine, return {"issues":[]}.';

router.post('/submission/:id/grammar', async (req, res) => {
  const sub = await loadSubmission(req, res);
  if (!sub) return;
  if (!allow(req.user.id, 'grammar', 15)) return page(res, sub, { error: 'You have used many grammar checks this hour. Try again later.' });
  try {
    const all = (await textOf(sub)).split(/\s+/);
    const parts = Math.ceil(all.length / PART_WORDS);
    const part = Math.min(Math.max(Number(req.body.part) || 1, 1), parts);
    const text = all.slice((part - 1) * PART_WORDS, part * PART_WORDS).join(' ');
    const raw = await ai.chat({ system: GRAMMAR_SYSTEM, messages: [{ role: 'user', content: text }], json: true, maxTokens: 2500 });
    let issues = [];
    try { issues = (JSON.parse(raw).issues || []).filter((i) => i && i.original && i.suggestion).slice(0, 15); }
    catch (e) { return page(res, sub, { error: 'The AI answer could not be read. Try again.' }); }
    page(res, sub, { grammar: { issues, part, parts } });
  } catch (e) {
    if (!(e instanceof ExtractError || e instanceof ai.AiError)) throw e;
    page(res, sub, { error: e.message });
  }
});

// ---------- chatbot ----------
async function chatSystem(user) {
  let s =
    'You are the ThesisTrack assistant, a friendly helper inside a web app where student groups submit thesis chapters (1 to 5), ' +
    'advisers review them, and the coordinator manages groups, advisers, panel members, defense schedules and announcements. ' +
    'Answer briefly and clearly. Help with thesis writing (structure of chapters, research problems, methodology, citations, ' +
    'defense preparation) and with how to use the app. Never write a student\'s thesis for them; guide them instead. ' +
    'You cannot approve chapters, change data or see other people\'s files. If you do not know something, say so. ' +
    `You are talking to ${user.name}, ${{ student: 'a student', adviser: 'an adviser', admin: 'the coordinator' }[user.role] || 'a user'}. `;
  if (user.role === 'student') {
    const g = await L.groupOfStudent(user.id);
    if (g) {
      const ch = await L.chaptersOf(g.id);
      s += `Their group is "${g.name}" with the title "${g.title}". Chapter status: ` +
        ch.map((c) => `Chapter ${c.number} ${c.status}${c.deadline ? ' (due ' + c.deadline + ')' : ''}`).join('; ') + '. ';
    }
  }
  return s + 'Today is ' + L.today() + '.';
}

router.post('/chat', async (req, res) => {
  if (!ai.provider()) return res.json({ error: 'The assistant is not switched on yet. Ask the coordinator to add a free AI key.' });
  if (!allow(req.user.id, 'chat', 40)) return res.json({ error: 'You have asked a lot this hour. Please try again later.' });
  let history = [];
  try { history = JSON.parse(req.body.history || '[]'); } catch (e) { /* start fresh */ }
  const messages = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-10).map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  const message = String(req.body.message || '').trim().slice(0, 1500);
  if (!message) return res.json({ error: 'Type a question first.' });
  messages.push({ role: 'user', content: message });
  while (messages[0].role !== 'user') messages.shift();
  try {
    res.json({ reply: await ai.chat({ system: await chatSystem(req.user), messages, maxTokens: 700 }) });
  } catch (e) {
    if (!(e instanceof ai.AiError)) throw e;
    res.json({ error: e.message });
  }
});

module.exports = router;
