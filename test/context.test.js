'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { tmpRepo } = require('./helpers');
const { resolveContext, lastAssistantText, MAX_CONTEXT } = require('../server/context');
const { runReview, parseArgs } = require('../server/review');
const { formatContext } = require('../server/agent');
const state = require('../server/state');
const gitlib = require('../server/git');

const AGENT = path.join(__dirname, '..', 'server', 'agent.js');

function agent(repo, args) {
  return new Promise((resolve) => {
    execFile('node', [AGENT, '--repo', repo, ...args], { encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    ).stdin.end();
  });
}

function setMtime(file, secondsAgo) {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, t, t);
}

test('parseArgs: context flags', () => {
  assert.equal(parseArgs(['--context', '-']).contextText, '-');
  assert.equal(parseArgs(['--context=Fix X']).contextText, 'Fix X');
  assert.equal(parseArgs(['branch', '--context-file', 'notes.md']).contextFile, 'notes.md');
  assert.equal(parseArgs(['--context-file=n.md']).contextFile, 'n.md');
});

test('resolveContext: explicit text, then fresh context.md, then the hook fallback', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  const gitDir = gitlib.gitDir(r.dir);
  const hookInput = { last_assistant_message: 'I fixed the bug.' };

  assert.equal(resolveContext({ gitDir }), null);
  assert.deepEqual(resolveContext({ gitDir, hookInput }), { text: 'I fixed the bug.', source: 'last-message' });

  fs.writeFileSync(state.contextFile(gitDir), '## Task\nFix the bug\n');
  assert.deepEqual(resolveContext({ gitDir, hookInput }), { text: '## Task\nFix the bug', source: 'file' });
  assert.deepEqual(resolveContext({ gitDir, text: '  explicit  ', hookInput }), { text: 'explicit', source: 'author' });

  // A context.md older than the last reviewed round is stale.
  state.writeLastReviewedHash(gitDir, 'abc');
  setMtime(state.contextFile(gitDir), 60);
  assert.equal(resolveContext({ gitDir }), null);
  assert.equal(resolveContext({ gitDir, hookInput }).source, 'last-message');

  // Rewritten after that round: fresh again.
  setMtime(state.lastReviewedFile(gitDir), 120);
  assert.equal(resolveContext({ gitDir }).source, 'file');
});

test('resolveContext: truncates long descriptions', () => {
  const ctx = resolveContext({ text: 'x'.repeat(MAX_CONTEXT + 100) });
  assert.ok(ctx.text.length < MAX_CONTEXT + 50);
  assert.match(ctx.text, /truncated\)$/);
});

test('lastAssistantText: last assistant text block from a transcript', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-tr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.jsonl');
  const lines = [
    { type: 'user', message: { content: 'please fix' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Earlier note' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed X by doing Y.' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  assert.equal(lastAssistantText(file), 'Fixed X by doing Y.');
  assert.equal(resolveContext({ hookInput: { transcript_path: file } }).text, 'Fixed X by doing Y.');
  assert.equal(lastAssistantText(path.join(dir, 'missing.jsonl')), '');
});

test('formatContext: labelled block, or a note when missing', () => {
  assert.match(formatContext(null), /none provided/);
  const out = formatContext({ text: '## Task\nFix X', source: 'author' });
  assert.match(out, /^=== Author's description of the change \(written by the author/);
  assert.match(out, /## Task\nFix X\n=== end of description ===/);
});

test('end to end: context reaches the UI, agent reviewers and history', async (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.js', 'const a = 1;\n');
  r.commit('init');
  r.write('a.js', 'const a = 2;\n');
  const gitDir = gitlib.gitDir(r.dir);
  fs.writeFileSync(state.contextFile(gitDir), 'from file');

  let url;
  const done = runReview({ cwd: r.dir, open: false, timeout: 1, context: '## Task\nBump a to 2', log: (u) => (url = u) });
  while (!url) await new Promise((res) => setTimeout(res, 10));
  const { origin, searchParams } = new URL(url);
  const headers = { 'X-Review-Token': searchParams.get('t'), 'Content-Type': 'application/json' };

  const meta = await (await fetch(`${origin}/api/meta`, { headers })).json();
  assert.deepEqual(meta.context, { text: '## Task\nBump a to 2', source: 'author' });

  const diff = await agent(r.dir, ['--as', 'Bob', 'diff']);
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /^=== Author's description[^\n]*\n## Task\nBump a to 2\n=== end of description ===/);
  assert.match(diff.stdout, /=== a\.js \(modified/);
  const noCtx = await agent(r.dir, ['--as', 'Bob', 'diff', '--no-context']);
  assert.doesNotMatch(noCtx.stdout, /Author's description/);
  const ctx = await agent(r.dir, ['--as', 'Bob', 'context']);
  assert.match(ctx.stdout, /Bump a to 2/);
  assert.doesNotMatch(ctx.stdout, /a\.js/);

  await fetch(`${origin}/api/submit`, { method: 'POST', headers, body: JSON.stringify({ verdict: 'approve', comments: [] }) });
  const result = await done;
  assert.equal(result.status, 'submitted');
  assert.doesNotMatch(result.markdown, /Bump a to 2/, 'the author does not get its own description back');
  assert.equal(state.lastHistory(gitDir).context.text, '## Task\nBump a to 2');
  assert.equal(fs.existsSync(state.contextFile(gitDir)), false, 'context.md is consumed by the round');
});
