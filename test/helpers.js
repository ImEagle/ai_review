'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = (msg) => {
    g('add', '-A');
    g('commit', '-q', '-m', msg);
  };
  return { dir, g, write, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { tmpRepo };
