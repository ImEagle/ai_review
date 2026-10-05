#!/usr/bin/env node
'use strict';

// Stop hook: when auto-review is enabled for the project and there are new,
// unreviewed changes, open the review UI and feed the result back to Claude.
// Every early exit is `exit 0` with no output, so the hook never traps a session.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const gitlib = require('./git');
const state = require('./state');
const { runReview } = require('./review');
const { hasFeedback } = require('./feedback');
const { agentPrompt } = require('./reviewers');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function currentHash(root) {
  return crypto.createHash('sha256').update(gitlib.getRawDiff(root, 'working')).digest('hex');
}

/** Returns null when no review should run, else { root, gitDir, hash }. */
function shouldReview(cwd) {
  if (!cwd || !gitlib.isGitRepo(cwd)) return null;
  const root = gitlib.repoRoot(cwd);
  const gitDir = gitlib.gitDir(root);
  if (!fs.existsSync(path.join(state.stateDir(gitDir), 'auto'))) return null;
  const raw = gitlib.getRawDiff(root, 'working');
  if (!raw.trim()) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  if (state.readLastReviewedHash(gitDir) === hash) return null;
  return { root, gitDir, hash };
}

async function main() {
  const input = readStdin();
  const target = shouldReview(input.cwd || process.cwd());
  if (!target) return;

  const result = await runReview({
    cwd: target.root,
    scope: 'working',
    hook: true,
    hookInput: input,
    open: !process.env.AI_REVIEW_NO_OPEN,
    timeout: parseFloat(process.env.AI_REVIEW_HOOK_TIMEOUT) || 55,
    log: (url) => process.stderr.write(`ai-review: review the changes at ${url}\nai-review: agent reviewers can join with: ${agentPrompt(target.root)}\n`),
  });

  // Remember the state we reviewed (whatever the outcome) so the same diff
  // never re-opens the UI. Claude's follow-up edits change the hash.
  state.writeLastReviewedHash(target.gitDir, currentHash(target.root));

  if (result.status !== 'submitted') return;
  const { review, markdown } = result;
  if (review.verdict === 'approve') return;
  if (!hasFeedback(review)) return;
  const note =
    `\n\n---\nBefore you stop again, write a short markdown description of your changes ` +
    `(Task / Approach / Changes by file / Not done or open questions) to ${state.contextFile(target.gitDir)}, ` +
    `overwriting it. The reviewers see it above the diff in the next round.\n`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason: markdown + note }));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`ai-review hook: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { shouldReview, currentHash };
