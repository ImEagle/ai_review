'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpRepo } = require('./helpers');
const { runReview } = require('../server/review');

test('end to end: draft, diff, submit → markdown', async (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.js', 'const a = 1;\n');
  r.commit('init');
  r.write('a.js', 'const a = 2;\n');

  let url;
  const done = runReview({ cwd: r.dir, open: false, timeout: 1, log: (u) => (url = u) });
  while (!url) await new Promise((res) => setTimeout(res, 10));
  const { origin, searchParams } = new URL(url);
  const headers = { 'X-Review-Token': searchParams.get('t'), 'Content-Type': 'application/json' };

  assert.equal((await fetch(`${origin}/api/meta`)).status, 403, 'token required');
  const page = await fetch(`${origin}/`);
  assert.match(await page.text(), /<title>Code Review<\/title>/);

  const meta = await (await fetch(`${origin}/api/meta`, { headers })).json();
  assert.equal(meta.branch, 'main');

  const diff = await (await fetch(`${origin}/api/diff?scope=working`, { headers })).json();
  assert.equal(diff.files[0].path, 'a.js');

  await fetch(`${origin}/api/draft`, { method: 'PUT', headers, body: JSON.stringify({ comments: [], general: 'wip' }) });
  const meta2 = await (await fetch(`${origin}/api/meta`, { headers })).json();
  assert.equal(meta2.draft.general, 'wip');

  const comment = { id: '1', scope: 'working', file: 'a.js', side: 'new', start: 1, end: 1, snippet: ['const a = 2;'], lang: 'javascript', body: 'Why 2?' };
  const res = await fetch(`${origin}/api/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ scope: 'working', verdict: 'request_changes', general: '', comments: [comment] }),
  });
  assert.equal(res.status, 200);

  const result = await done;
  assert.equal(result.status, 'submitted');
  assert.match(result.markdown, /CHANGES REQUESTED/);
  assert.match(result.markdown, /## a\.js\n\n### L1 \(new\)\n```javascript\nconst a = 2;\n```\n> Why 2\?/);
});
