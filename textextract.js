// Reads the text out of uploaded PDF and DOCX files. The text is saved in submission_text so each file is read once.
const path = require('path');
const db = require('./db');

class ExtractError extends Error {}

async function readFile(file, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: require('fs').readFileSync(file) });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  if (ext === '.docx') return (await require('mammoth').extractRawText({ path: file })).value;
  if (ext === '.txt') return require('fs').readFileSync(file, 'utf8');
  throw new ExtractError('This kind of file cannot be read (old .doc files, for example). Save the chapter as .docx or PDF and upload it again.');
}

// sub is a row from submissions. Returns plain text, or throws ExtractError with a message safe to show.
async function textOf(sub) {
  const cached = await db.get('SELECT body FROM submission_text WHERE submission_id = ?', [sub.id]);
  if (cached) return cached.body;
  let text;
  try {
    text = await readFile(path.join(db.UPLOAD_DIR, path.basename(sub.stored_name)), sub.original_name);
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    console.error('extract failed', sub.id, e.message);
    throw new ExtractError('That file could not be read. It may be scanned images, protected, or damaged.');
  }
  text = text.replace(/^-- \d+ of \d+ --$/gm, '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.split(/\s+/).length < 30) throw new ExtractError('There is almost no text in this file (it may be a scan). A checker needs selectable text.');
  await db.run('INSERT IGNORE INTO submission_text (submission_id, body) VALUES (?, ?)', [sub.id, text]);
  return text;
}

module.exports = { textOf, ExtractError };
