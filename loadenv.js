// Loads settings from a .env file in the project folder, if there is one (the file is not committed to git).
// Variables already set in the terminal win over the file.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '.env');
if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(file);
  } catch (e) {
    console.warn(`Could not read .env: ${e.message}`);
  }
}
