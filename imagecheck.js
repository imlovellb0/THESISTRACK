// Checks the first bytes of an uploaded file, so a renamed non-image is not accepted as a JPG, PNG or WEBP photo.
const fs = require('fs');

function looksLikeImage(file) {
  const head = Buffer.alloc(12);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const webp = head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP';
  return jpg || png || webp;
}

module.exports = { looksLikeImage };
