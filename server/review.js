#!/usr/bin/env node
'use strict';

// Starts the local review UI, waits for the reviewer, prints the feedback.
//
// Usage: node review.js [--scope working|branch|commits:N] [--port N] [--no-open] [--timeout MIN]

const { spawn } = require('node:child_process');
const gitlib = require('./git');
const { createReviewServer } = require('./http');
const { agentPrompt } = require('./reviewers');

function parseArgs(argv) {
  const opts = { scope: 'working', port: 0, open: !process.env.AI_REVIEW_NO_OPEN, timeout: 120, hook: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--scope') opts.scope = val();
    else if (a.startsWith('--scope=')) opts.scope = a.slice(8);
    else if (a === '--port') opts.port = parseInt(val(), 10) || 0;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--timeout') opts.timeout = parseFloat(val()) || 0;
    else if (a === '--hook') opts.hook = true;
    else if (a === 'branch' || a === 'working' || /^commits:\d+$/.test(a)) opts.scope = a;
    else if (/^\d+$/.test(a)) opts.scope = `commits:${a}`;
    else if (a === '-h' || a === '--help') opts.help = true;
  }
  return opts;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the URL is printed anyway */
  }
}

/**
 * Runs one review round. Resolves with { status: 'submitted'|'cancelled'|'timeout', review?, markdown? }.
 * `log(url)` is called once the server is listening.
 */
async function runReview({ cwd, scope = 'working', port = 0, open = true, timeout = 120, hook = false, log = () => {} }) {
  const root = gitlib.repoRoot(cwd);
  const gitDir = gitlib.gitDir(cwd);

  let resolveDone;
  const donePromise = new Promise((r) => (resolveDone = r));
  const srv = createReviewServer({ root, gitDir, initialScope: scope, hook, onDone: resolveDone });
  const url = await srv.listen(port);
  log(url);
  if (open) openBrowser(url);

  // Remove session.json even when killed (Ctrl-C, hook timeout, background task stop).
  const onSignal = (sig) => {
    srv.close();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let timer;
  if (timeout > 0) {
    timer = setTimeout(() => resolveDone({ status: 'timeout' }), timeout * 60 * 1000);
  }
  const result = await donePromise;
  clearTimeout(timer);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  // Give the browser a moment to receive the submit response.
  await new Promise((r) => setTimeout(r, 150));
  srv.close();
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: review.js [working|branch|commits:N|N] [--port N] [--no-open] [--timeout MIN]');
    return;
  }
  const cwd = process.cwd();
  if (!gitlib.isGitRepo(cwd)) {
    console.log('ai-review: not inside a git repository; nothing to review.');
    process.exitCode = 2;
    return;
  }

  const result = await runReview({
    ...opts,
    cwd,
    log: (url) =>
      console.log(
        `Review UI: ${url}\n\n` +
          `Agent reviewers (optional): paste this into another agent session, replacing NAME (e.g. Alice):\n` +
          `  ${agentPrompt(gitlib.repoRoot(cwd))}\n\n` +
          `Waiting for the reviewer to submit (timeout ${opts.timeout || '∞'} min)…\n`
      ),
  });

  if (result.status === 'submitted') {
    console.log('=== REVIEW SUBMITTED ===\n');
    process.stdout.write(result.markdown);
  } else if (result.status === 'cancelled') {
    console.log('=== REVIEW CANCELLED === The reviewer closed the review without feedback.');
  } else {
    console.log('=== REVIEW TIMED OUT === No review was submitted.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ai-review: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runReview, parseArgs };
