// Plagiarism check that runs on this server, with no AI and no cost. It compares a chapter with the latest upload of
// every chapter from OTHER groups in the same workspace, using overlapping runs of words. It does not search the internet.
const db = require('./db');
const { textOf, ExtractError } = require('./textextract');

const N = 6; // a "match" is 6 words in a row that also appear in the other text

const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
function shingles(ws) {
  const out = new Set();
  for (let i = 0; i + N <= ws.length; i++) out.add(ws.slice(i, i + N).join(' '));
  return out;
}

async function check(sub, groupId) {
  const mine = shingles(words(await textOf(sub)));
  if (mine.size < 20) throw new ExtractError('There is too little text to check.');

  const others = await db.all(
    `SELECT s.*, c.number AS chapter_no, g.name AS group_name FROM submissions s
       JOIN chapters c ON c.id = s.chapter_id JOIN thesis_groups g ON g.id = c.group_id
      WHERE c.group_id != ? AND g.workspace_id = (SELECT workspace_id FROM thesis_groups WHERE id = ?)
        AND s.version_no = (SELECT MAX(version_no) FROM submissions WHERE chapter_id = s.chapter_id)`,
    [groupId, groupId]
  );

  const matched = new Set();
  const sources = [];
  let skipped = 0;
  for (const o of others) {
    let theirs;
    try { theirs = shingles(words(await textOf(o))); } catch (e) { skipped++; continue; }
    let hits = 0;
    for (const s of mine) if (theirs.has(s)) { hits++; matched.add(s); }
    if (hits) sources.push({ group: o.group_name, chapter: o.chapter_no, percent: Math.round((hits / mine.size) * 100) });
  }
  sources.sort((a, b) => b.percent - a.percent);

  // Sentences of this chapter where most word-runs were found elsewhere.
  const sentences = [];
  for (const raw of (await textOf(sub)).split(/(?<=[.!?])\s+|\n+/)) {
    const sh = [...shingles(words(raw))];
    if (sh.length >= 3 && sh.filter((s) => matched.has(s)).length / sh.length >= 0.5) sentences.push(raw.trim().slice(0, 300));
    if (sentences.length >= 8) break;
  }

  return {
    percent: Math.round((matched.size / mine.size) * 100),
    compared: others.length - skipped,
    skipped,
    sources: sources.slice(0, 5),
    sentences,
  };
}

module.exports = { check };
