'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpRepo } = require('./helpers');
const gitlib = require('../server/git');

test('working scope includes staged, unstaged and untracked changes', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.txt', 'one\ntwo\n');
  r.write('b.txt', 'b\n');
  r.commit('init');
  r.write('a.txt', 'one\nTWO\n');
  r.write('b.txt', 'B\n');
  r.g('add', 'b.txt');
  r.write('dir/new file.txt', 'fresh\n');

  const { files } = gitlib.getDiff(r.dir, 'working');
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'b.txt', 'dir/new file.txt']);
  assert.equal(byPath['dir/new file.txt'].status, 'added');
  assert.equal(byPath['a.txt'].additions, 1);
});

test('working scope works in a repo without commits', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('x.txt', 'x\n');
  r.g('add', 'x.txt');
  r.write('y.txt', 'y\n');
  const { files } = gitlib.getDiff(r.dir, 'working');
  assert.deepEqual(files.map((f) => f.path).sort(), ['x.txt', 'y.txt']);
});

test('branch and commits scopes', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.txt', '1\n');
  r.commit('init');
  r.g('checkout', '-q', '-b', 'feature');
  r.write('a.txt', '2\n');
  r.commit('c2');
  r.write('b.txt', 'b\n');
  r.commit('c3');
  r.write('c.txt', 'wip\n');

  const scopes = gitlib.getScopes(r.dir);
  assert.equal(scopes.branch, 'feature');
  assert.equal(scopes.base, 'main');
  assert.deepEqual(scopes.scopes.map((s) => s.id), ['working', 'branch']);
  assert.equal(scopes.commits.length, 3);

  assert.deepEqual(gitlib.getDiff(r.dir, 'branch').files.map((f) => f.path).sort(), ['a.txt', 'b.txt', 'c.txt']);
  assert.deepEqual(gitlib.getDiff(r.dir, 'commits:1').files.map((f) => f.path), ['b.txt']);
  assert.deepEqual(gitlib.getDiff(r.dir, 'commits:2').files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  // More commits than history: diff against the empty tree.
  assert.deepEqual(gitlib.getDiff(r.dir, 'commits:10').files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
});

test('context option widens hunks', (t) => {
  const r = tmpRepo();
  t.after(r.cleanup);
  r.write('a.txt', Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n') + '\n');
  r.commit('init');
  r.write('a.txt', Array.from({ length: 30 }, (_, i) => (i === 14 ? 'CHANGED' : `l${i + 1}`)).join('\n') + '\n');
  const lines = (ctx) => gitlib.getDiff(r.dir, 'working', { context: ctx }).files[0].hunks[0].lines.length;
  assert.equal(lines(3), 8);
  assert.equal(lines('all'), 31);
});
