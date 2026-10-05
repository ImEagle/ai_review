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

test('hook passes the last assistant message to the UI and tells Claude where to describe changes', async (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.txt', 'a\n');
  r.commit('init');
  execFileSync('node', [AUTO, 'on'], { cwd: r.dir });
  r.write('a.txt', 'b\n');

  const { spawn } = require('node:child_process');
  const child = spawn('node', [HOOK], { env: { ...process.env, AI_REVIEW_NO_OPEN: '1' } });
  child.stdin.end(JSON.stringify({ cwd: r.dir, last_assistant_message: 'Changed a to b.' }));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  const url = await new Promise((resolve) =>
    child.stderr.on('data', (d) => {
      stderr += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/.exec(stderr);
      if (m) resolve(m[0]);
    })
  );
  const { origin, searchParams } = new URL(url);
  const headers = { 'X-Review-Token': searchParams.get('t'), 'Content-Type': 'application/json' };
  const meta = await (await fetch(`${origin}/api/meta`, { headers })).json();
  assert.deepEqual(meta.context, { text: 'Changed a to b.', source: 'last-message' });

  const comment = { id: '1', file: 'a.txt', side: 'new', start: 1, end: 1, snippet: ['b'], body: 'Why?' };
  await fetch(`${origin}/api/submit`, { method: 'POST', headers, body: JSON.stringify({ verdict: 'comment', comments: [comment] }) });
  await new Promise((resolve) => child.on('close', resolve));
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Why\?/);
  assert.ok(out.reason.includes(state.contextFile(gitlib.gitDir(r.dir))));
});
