// AI helpers for every signed-in role: grammar suggestions.
const router = require('express').Router();
const PART_WORDS = 1200;
const db = require('../db');
const L = require('../lib');
const ai = require('../ai');
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

module.exports = router;
