'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function getDaemonVersion() {
  const root = __dirname;
  const files = ['main.js', 'version.js', 'registry.js', 'ui-protocol.js', 'history.js', '../web/index.html', '../web/context.html', '../web/context-graph.js', '../web/context-projection.js', '../../rolling-context/projection/snapshot-codec.js', '../../rolling-context/projection/state.ts', '../../rolling-context/projection/common.ts', '../../rolling-context/legacy/v1.ts'];
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
