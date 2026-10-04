'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUnifiedDiff } = require('../server/git');

test('parses a modified file with line numbers', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    'index 111..222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,3 +1,4 @@ function x() {',
    ' one',
    '-two',
    '+TWO',
    '+three',
    ' four',
    '\\ No newline at end of file',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'src/a.js');
  assert.equal(f.status, 'modified');
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
  const lines = f.hunks[0].lines;
  assert.deepEqual(lines.map((l) => [l.type, l.oldNo, l.newNo]), [
    ['ctx', 1, 1],
    ['del', 2, null],
    ['add', null, 2],
    ['add', null, 3],
    ['ctx', 3, 4],
  ]);
  assert.equal(lines[4].noNewline, true);
});

test('parses added, deleted, renamed and binary files', () => {
  const diff = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/x.txt b/y.txt',
    'similarity index 100%',
    'rename from x.txt',
    'rename to y.txt',
    'diff --git a/img.png b/img.png',
    'index 1..2 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((f) => [f.status, f.oldPath, f.newPath, f.binary]), [
    ['added', null, 'new.txt', false],
    ['deleted', 'old.txt', null, false],
    ['renamed', 'x.txt', 'y.txt', false],
    ['modified', 'img.png', 'img.png', true],
  ]);
  assert.equal(files[1].path, 'old.txt');
});

test('content lines that look like headers stay content', () => {
  const diff = [
    'diff --git a/a b/a',
    '--- a/a',
    '+++ b/a',
    '@@ -1,2 +1,2 @@',
    '--- not a header',
    '+++ not a header either',
    ' ctx',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'a');
  assert.deepEqual(f.hunks[0].lines.map((l) => [l.type, l.text]), [
    ['del', '-- not a header'],
    ['add', '++ not a header either'],
    ['ctx', 'ctx'],
  ]);
});

test('handles paths with spaces and quoted unicode', () => {
  const files = parseUnifiedDiff(
    ['diff --git a/my file.txt b/my file.txt', 'new file mode 100644', '--- /dev/null', '+++ b/my file.txt', '@@ -0,0 +1 @@', '+x'].join('\n')
  );
  assert.equal(files[0].path, 'my file.txt');
  const q = parseUnifiedDiff(['diff --git "a/tab\\there" "b/tab\\there"', '--- "a/tab\\there"', '+++ "b/tab\\there"'].join('\n'));
  assert.equal(q[0].path, 'tab\there');
});
