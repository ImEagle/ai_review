'use strict';

// Review state lives inside .git/ so it never shows up in the diff being reviewed.
const fs = require('node:fs');
const path = require('node:path');

function stateDir(gitDir) {
  const dir = path.join(gitDir, 'ai-review');
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const emptyDraft = () => ({ comments: [], general: '', verdict: 'comment', viewed: [] });

function readDraft(gitDir) {
  return { ...emptyDraft(), ...readJson(path.join(stateDir(gitDir), 'draft.json'), {}) };
}

function writeDraft(gitDir, draft) {
  writeJson(path.join(stateDir(gitDir), 'draft.json'), draft);
}

function clearDraft(gitDir) {
  fs.rmSync(path.join(stateDir(gitDir), 'draft.json'), { force: true });
}

function saveHistory(gitDir, review) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(stateDir(gitDir), 'history', `${stamp}.json`);
  writeJson(file, review);
  return file;
}

function lastHistory(gitDir) {
  const dir = path.join(stateDir(gitDir), 'history');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  return readJson(path.join(dir, files[files.length - 1]), null);
}

function readLastReviewedHash(gitDir) {
  try {
    return fs.readFileSync(path.join(stateDir(gitDir), 'last-reviewed'), 'utf8').trim();
  } catch {
    return null;
  }
}

function writeLastReviewedHash(gitDir, hash) {
  fs.writeFileSync(path.join(stateDir(gitDir), 'last-reviewed'), hash + '\n');
}

module.exports = {
  stateDir,
  readDraft,
  writeDraft,
  clearDraft,
  saveHistory,
  lastHistory,
  readLastReviewedHash,
  writeLastReviewedHash,
};
