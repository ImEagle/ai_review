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

const lastReviewedFile = (gitDir) => path.join(stateDir(gitDir), 'last-reviewed');

function readLastReviewedHash(gitDir) {
  try {
    return fs.readFileSync(lastReviewedFile(gitDir), 'utf8').trim();
  } catch {
    return null;
  }
}

function writeLastReviewedHash(gitDir, hash) {
  fs.writeFileSync(lastReviewedFile(gitDir), hash + '\n');
}

// context.md: the implementing agent's description of the change, for reviewers.
const contextFile = (gitDir) => path.join(stateDir(gitDir), 'context.md');

function readContextFile(gitDir) {
  try {
    return fs.readFileSync(contextFile(gitDir), 'utf8');
  } catch {
    return '';
  }
}

function clearContextFile(gitDir) {
  fs.rmSync(contextFile(gitDir), { force: true });
}

// Agent reviewers' comments are kept apart from the user's draft so the UI's
// whole-draft writes can never clobber them.
const emptyAgents = () => ({ reviewers: {}, comments: [] });

function readAgents(gitDir) {
  return { ...emptyAgents(), ...readJson(path.join(stateDir(gitDir), 'agents.json'), {}) };
}

function writeAgents(gitDir, data) {
  writeJson(path.join(stateDir(gitDir), 'agents.json'), data);
}

function clearAgents(gitDir) {
  fs.rmSync(path.join(stateDir(gitDir), 'agents.json'), { force: true });
}

// session.json tells agent.js how to reach the running review server.
function writeSession(gitDir, session) {
  writeJson(path.join(stateDir(gitDir), 'session.json'), session);
}

function readSession(gitDir) {
  return readJson(path.join(stateDir(gitDir), 'session.json'), null);
}

function clearSession(gitDir, pid = process.pid) {
  const s = readSession(gitDir);
  if (s && s.pid === pid) fs.rmSync(path.join(stateDir(gitDir), 'session.json'), { force: true });
}

module.exports = {
  readAgents,
  writeAgents,
  clearAgents,
  writeSession,
  readSession,
  clearSession,
  stateDir,
  readDraft,
  writeDraft,
  clearDraft,
  saveHistory,
  lastHistory,
  readLastReviewedHash,
  writeLastReviewedHash,
  lastReviewedFile,
  contextFile,
  readContextFile,
  clearContextFile,
};
