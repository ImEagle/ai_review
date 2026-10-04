#!/usr/bin/env node
'use strict';

// Toggle the auto-review Stop hook for the current repository.
// Usage: node auto.js on|off|status

const fs = require('node:fs');
const path = require('node:path');
const gitlib = require('./git');
const state = require('./state');

const flagFile = (gitDir) => path.join(state.stateDir(gitDir), 'auto');

function isEnabled(gitDir) {
  return fs.existsSync(flagFile(gitDir));
}

function main() {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  const cwd = process.cwd();
  if (!gitlib.isGitRepo(cwd)) {
    console.log('ai-review: not inside a git repository.');
    process.exitCode = 2;
    return;
  }
  const gitDir = gitlib.gitDir(cwd);
  if (cmd === 'on') {
    fs.writeFileSync(flagFile(gitDir), new Date().toISOString() + '\n');
    // Treat the current state as already reviewed, so the hook only fires for new changes.
    state.writeLastReviewedHash(gitDir, require('./stop-hook').currentHash(gitlib.repoRoot(cwd)));
  } else if (cmd === 'off') {
    fs.rmSync(flagFile(gitDir), { force: true });
  } else if (cmd !== 'status') {
    console.log('Usage: auto.js on|off|status');
    process.exitCode = 2;
    return;
  }
  console.log(`ai-review auto-review is ${isEnabled(gitDir) ? 'ON' : 'OFF'} for ${gitlib.repoRoot(cwd)}`);
}

if (require.main === module) main();

module.exports = { isEnabled, flagFile };
