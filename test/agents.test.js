'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { tmpRepo } = require('./helpers');
const { runReview } = require('../server/review');
const gitlib = require('../server/git');
const { ReviewerStore } = require('../server/reviewers');
const { formatFeedback, hasFeedback } = require('../server/feedback');

const AGENT = path.join(__dirname, '..', 'server', 'agent.js');

async function agent(repo, args, input) {
  return new Promise((resolve) => {
    const child = execFile('node', [AGENT, '--repo', repo, ...args], { encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('agent.js without a running review explains what to do', async (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.txt', 'a\n');
  r.commit('init');
  const res = await agent(r.dir, ['--as', 'Alice', 'diff']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /No review is running/);
  const guide = await agent(r.dir, ['--as', 'Alice', 'guide']);
  assert.equal(guide.code, 0);
  assert.match(guide.stdout, /You are "Alice"/);
});

test('agent reviewers: comment, validate, accept/reject, merged submit', async (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.js', 'const a = 1;\nconst b = 2;\n');
  r.commit('init');
  r.write('a.js', 'const a = 1;\nconst b = 3;\nconst c = 4;\n');

  let url;
  const done = runReview({ cwd: r.dir, open: false, timeout: 1, log: (u) => (url = u) });
  while (!url) await new Promise((res) => setTimeout(res, 10));
  const { origin, searchParams } = new URL(url);
  const ui = { 'X-Review-Token': searchParams.get('t'), 'Content-Type': 'application/json' };
  const sessionFile = path.join(gitlib.gitDir(r.dir), 'ai-review', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

  // diff output has numbered columns
  const diff = await agent(r.dir, ['--as', 'Alice', 'diff']);
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /=== a\.js \(modified, \+2 -1\) ===/);
  assert.match(diff.stdout, /^\s+2\s+- const b = 2;$/m);
  assert.match(diff.stdout, /^\s+3 \+ const c = 4;$/m);

  // validation
  let res = await agent(r.dir, ['--as', 'Alice', 'comment', '--file', 'a.js', '--line', '9', '--body', 'x']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /Line 9 is not on the new side of a\.js \(available: 1–3\)/);
  res = await agent(r.dir, ['--as', 'Alice', 'comment', '--file', 'zzz.js', '--line', '1', '--body', 'x']);
  assert.match(res.stderr, /not part of the reviewed changes/);
  res = await agent(r.dir, ['--as', 'you', 'comment', '--file', 'a.js', '--body', 'x']);
  assert.match(res.stderr, /reserved/);

  // valid comments (stdin body, old side, range) + a verdict
  res = await agent(r.dir, ['--as', 'Alice', 'comment', '--file', 'a.js', '--line', '2', '--end', '3', '--body', '-'], 'Why change b?\nAnd add c?');
  assert.equal(res.code, 0, res.stderr);
  res = await agent(r.dir, ['--as', 'Alice', 'comment', '--file', 'a.js', '--line', '2', '--old', '--body', 'Keep 2']);
  assert.equal(res.code, 0, res.stderr);
  res = await agent(r.dir, ['--as', 'Bob', 'comment', '--file', 'a.js', '--line', '1', '--body', 'Nit: rename a']);
  assert.equal(res.code, 0, res.stderr);
  res = await agent(r.dir, ['--as', 'Alice', 'finish', '--verdict', 'request_changes', '--summary', 'Two questions.']);
  assert.match(res.stdout, /Recorded verdict "request_changes" for Alice/);
  res = await agent(r.dir, ['--as', 'Bob', 'finish', '--verdict', 'maybe']);
  assert.match(res.stderr, /Verdict must be one of/);

  // token separation
  assert.equal((await fetch(`${origin}/api/submit`, { method: 'POST', headers: { 'X-Agent-Token': session.agentToken } })).status, 403);
  assert.equal((await fetch(`${origin}/agent-api/info`, { headers: ui })).status, 403);

  // UI sees them; accept one of Alice's, reject Bob's via bulk
  const agents = await (await fetch(`${origin}/api/agents`, { headers: ui })).json();
  assert.deepEqual(agents.reviewers.map((x) => x.name).sort(), ['Alice', 'Bob']);
  assert.equal(agents.comments.length, 3);
  const range = agents.comments.find((c) => c.start === 2 && c.side === 'new');
  assert.deepEqual(range.snippet, ['const b = 3;', 'const c = 4;']);
  await fetch(`${origin}/api/agent-comments/${range.id}`, { method: 'POST', headers: ui, body: JSON.stringify({ status: 'accepted' }) });
  await fetch(`${origin}/api/agent-comments/bulk`, { method: 'POST', headers: ui, body: JSON.stringify({ author: 'Bob', status: 'rejected' }) });
  const after = await (await fetch(`${origin}/api/agents`, { headers: ui })).json();
  assert.deepEqual(after.comments.map((c) => `${c.author}:${c.status}`).sort(), ['Alice:accepted', 'Alice:pending', 'Bob:rejected']);

  const userComment = { id: 'u1', scope: 'working', file: 'a.js', side: 'new', start: 3, end: 3, snippet: ['const c = 4;'], body: 'Mine.' };
  await fetch(`${origin}/api/submit`, { method: 'POST', headers: ui, body: JSON.stringify({ verdict: 'request_changes', comments: [userComment] }) });
  const result = await done;

  const md = result.markdown;
  assert.match(md, /- \*\*Alice\*\* — CHANGES REQUESTED, 2 comments kept:\n  > Two questions\./);
  assert.match(md, /### L2–L3 \(new\) · Alice/);
  assert.match(md, /### L2 \(old\/deleted lines\) · Alice/);
  assert.match(md, /### L3 \(new\) · user/);
  assert.doesNotMatch(md, /Bob|rename a/);
  assert.ok(!fs.existsSync(sessionFile), 'session.json removed');
  assert.ok(!fs.existsSync(path.join(gitlib.gitDir(r.dir), 'ai-review', 'agents.json')), 'agents.json cleared');

  const late = await agent(r.dir, ['--as', 'Alice', 'status']);
  assert.match(late.stderr, /No review is running/);
});

test('sandboxed agent (no network) gets a sandbox hint, not "no review"', { skip: process.platform !== 'darwin' && 'needs macOS sandbox-exec' }, async (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.txt', 'a\n');
  r.commit('init');
  r.write('a.txt', 'b\n');
  let url;
  const done = runReview({ cwd: r.dir, open: false, timeout: 1, log: (u) => (url = u) });
  while (!url) await new Promise((res) => setTimeout(res, 10));

  const res = await new Promise((resolve) =>
    execFile('sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', 'node', AGENT, '--repo', r.dir, '--as', 'Alice', 'diff'], { encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stderr })
    )
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /A review IS running .* sandboxed without network access/);

  const { origin, searchParams } = new URL(url);
  await fetch(`${origin}/api/cancel`, { method: 'POST', headers: { 'X-Review-Token': searchParams.get('t') } });
  await done;
});

test('reviewer store: inherited names are ordinary reviewers, Reject all also rejects accepted', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.js', 'const a = 1;\n');
  r.commit('init');
  r.write('a.js', 'const a = 2;\nconst b = 3;\n');
  const store = new ReviewerStore({ root: r.dir, gitDir: gitlib.gitDir(r.dir), scope: 'working' });

  for (const name of ['__proto__', 'constructor', 'toString']) store.finish(name, 'request_changes', `Summary from ${name}`);
  assert.deepEqual(store.snapshot().reviewers.map((x) => `${x.name}:${x.summary}`), ['__proto__:Summary from __proto__', 'constructor:Summary from constructor', 'toString:Summary from toString']);
  assert.equal({}.verdict, undefined, 'Object.prototype untouched');
  // survives a reload from agents.json
  const reloaded = new ReviewerStore({ root: r.dir, gitDir: gitlib.gitDir(r.dir), scope: 'working' });
  assert.equal(reloaded.snapshot().reviewers.length, 3);
  assert.equal(Object.getPrototypeOf(reloaded.data.reviewers), null);

  const c1 = store.addComment('Alice', { file: 'a.js', start: 1, body: 'one' });
  store.addComment('Alice', { file: 'a.js', start: 2, body: 'two' });
  store.setStatus(c1.id, 'accepted');
  store.bulk('Alice', 'accepted');
  store.bulk('Alice', 'rejected');
  assert.deepEqual(store.commentsFor('Alice').map((c) => c.status), ['rejected', 'rejected']);
  store.clear();
});

test('feedback: a kept reviewer summary alone is actionable', () => {
  const review = { verdict: 'request_changes', general: '', comments: [], reviewers: [{ name: 'Alice', verdict: 'request_changes', summary: 'Tests are missing.' }] };
  assert.ok(hasFeedback(review));
  const md = formatFeedback(review);
  assert.match(md, /- \*\*Alice\*\* — CHANGES REQUESTED, 0 comments kept:\n  > Tests are missing\./);
  assert.match(md, /Address every comment and agent reviewer summary above/);
  assert.doesNotMatch(md, /submitted no comments/);
  assert.ok(!hasFeedback({ ...review, reviewers: [{ name: 'Alice', verdict: 'request_changes', summary: '' }] }));
});
