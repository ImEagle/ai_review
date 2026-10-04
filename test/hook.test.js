'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { tmpRepo } = require('./helpers');
const { shouldReview, currentHash } = require('../server/stop-hook');
const state = require('../server/state');
const gitlib = require('../server/git');

const AUTO = path.join(__dirname, '..', 'server', 'auto.js');
const HOOK = path.join(__dirname, '..', 'server', 'stop-hook.js');

test('hook gating: flag, diff, and last-reviewed hash', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.txt', 'a\n');
  r.commit('init');

  assert.equal(shouldReview(r.dir), null, 'not enabled');

  execFileSync('node', [AUTO, 'on'], { cwd: r.dir });
  assert.equal(shouldReview(r.dir), null, 'enabled but no diff');

  r.write('a.txt', 'b\n');
  const target = shouldReview(r.dir);
  assert.ok(target, 'enabled with new diff');

  state.writeLastReviewedHash(gitlib.gitDir(r.dir), currentHash(r.dir));
  assert.equal(shouldReview(r.dir), null, 'same diff already reviewed');

  r.write('a.txt', 'c\n');
  assert.ok(shouldReview(r.dir), 'diff changed after review');

  execFileSync('node', [AUTO, 'off'], { cwd: r.dir });
  assert.equal(shouldReview(r.dir), null, 'disabled again');
});

test('auto on marks existing changes as reviewed', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.txt', 'a\n');
  r.commit('init');
  r.write('a.txt', 'pending\n');
  execFileSync('node', [AUTO, 'on'], { cwd: r.dir });
  assert.equal(shouldReview(r.dir), null);
});

test('hook process exits 0 with no output when disabled or outside git', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  for (const cwd of [r.dir, require('node:os').tmpdir()]) {
    const out = execFileSync('node', [HOOK], { input: JSON.stringify({ cwd }), encoding: 'utf8' });
    assert.equal(out, '');
  }
});
