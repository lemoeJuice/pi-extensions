'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function getDaemonVersion() {
  const root = __dirname;
  const files = ['main.js', 'version.js', 'registry.js', 'history.js', '../web/index.html'];
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, path.resolve(root, file)));
    hash.update('\0');
    hash.update(fs.readFileSync(path.resolve(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

module.exports = { getDaemonVersion };
