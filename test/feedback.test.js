'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatFeedback } = require('../server/feedback');

test('formats a change request grouped by file', () => {
  const md = formatFeedback(
    {
      verdict: 'request_changes',
      general: 'Nice start.\nA few things:',
      comments: [
        { file: 'src/b.ts', side: 'new', start: 10, end: 12, snippet: ['a', 'b', 'c'], lang: 'typescript', body: 'Extract this.' },
        { file: 'src/a.js', side: 'old', start: 3, end: 3, snippet: ['keep()'], lang: 'javascript', body: "Don't delete this." },
        { file: 'src/a.js', side: 'new', start: null, end: null, snippet: [], body: 'File needs tests.' },
        { file: 'src/a.js', side: 'new', start: 5, end: 5, snippet: ['x = 1'], lang: 'javascript', body: '```suggestion\nx = 2\n```' },
        { file: 'src/a.js', side: 'new', start: 9, end: 9, body: '   ' },
      ],
    },
    { scopeLabel: 'uncommitted changes' }
  );
  const expected = `# Code review — CHANGES REQUESTED
Scope: uncommitted changes · 4 comments · 2 files

## General

> Nice start.
> A few things:

## src/a.js

### File-level comment
> File needs tests.

### L3 (old/deleted lines)
\`\`\`javascript
keep()
\`\`\`
> Don't delete this.

### L5 (new)
\`\`\`javascript
x = 1
\`\`\`
> \`\`\`suggestion
> x = 2
> \`\`\`

## src/b.ts

### L10–L12 (new)
\`\`\`typescript
a
b
c
\`\`\`
> Extract this.

---
\`suggestion\` blocks contain the exact replacement for the commented lines.
Address every comment above. Line numbers refer to the diff that was reviewed and may have shifted.
When done, reply with a per-comment summary of what you changed (or why you did not).
`;
  assert.equal(md, expected);
});

test('approval without comments', () => {
  const md = formatFeedback({ verdict: 'approve', general: '', comments: [] });
  assert.match(md, /^# Code review — APPROVED/);
  assert.match(md, /No action needed/);
});

test('snippet containing backticks gets a longer fence', () => {
  const md = formatFeedback({ verdict: 'comment', comments: [{ file: 'a.md', side: 'new', start: 1, end: 1, snippet: ['```js'], body: 'hm' }] });
  assert.match(md, /````\n```js\n````/);
});
