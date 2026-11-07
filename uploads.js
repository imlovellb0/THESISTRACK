// Chapter file uploads: PDF, DOC, DOCX up to 10 MB, saved under a random name.
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const ALLOWED = ['.pdf', '.doc', '.docx'];
const upload = multer({
  storage: multer.diskStorage({
    destination: db.UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    ALLOWED.includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('WRONG_TYPE')),
});
const removeFile = (file) => file && fs.rmSync(file.path, { force: true });

// Checks the first bytes, so a renamed .exe or .html is not accepted as a PDF or Word file.
function looksLikeDocument(file) {
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') return head.subarray(0, 4).toString('latin1') === '%PDF';
  if (ext === '.docx') return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  return head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])); // .doc
}

module.exports = { upload, removeFile, looksLikeDocument };
