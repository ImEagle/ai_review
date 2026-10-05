'use strict';

// The implementing agent's description of the change (task, approach, notes),
// shown to reviewers next to the diff. Sources, first match wins:
//   1. explicit text (review.js --context-file PATH / --context - / --context=TEXT)
//   2. <gitDir>/ai-review/context.md, if written after the last reviewed round
//   3. hook only: the agent's last message (Stop hook input or its transcript)

const fs = require('node:fs');
const state = require('./state');

const MAX_CONTEXT = 20 * 1024;

function clip(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.length > MAX_CONTEXT ? t.slice(0, MAX_CONTEXT) + '\n\n…(truncated)' : t;
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Text of the last assistant message in a Claude Code transcript (JSONL). */
function lastAssistantText(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return '';
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    if (text.trim()) return text;
  }
  return '';
}

/** Returns { text, source: 'author'|'file'|'last-message' } or null. */
function resolveContext({ gitDir, text, hookInput } = {}) {
  const explicit = clip(text);
  if (explicit) return { text: explicit, source: 'author' };

  if (gitDir) {
    const file = state.contextFile(gitDir);
    const written = mtime(file);
    const reviewed = mtime(state.lastReviewedFile(gitDir));
    if (written != null && (reviewed == null || written > reviewed)) {
      const fromFile = clip(state.readContextFile(gitDir));
      if (fromFile) return { text: fromFile, source: 'file' };
    }
  }

  if (hookInput) {
    const last = clip(hookInput.last_assistant_message || (hookInput.transcript_path && lastAssistantText(hookInput.transcript_path)));
    if (last) return { text: last, source: 'last-message' };
  }
  return null;
}

module.exports = { resolveContext, lastAssistantText, MAX_CONTEXT };
