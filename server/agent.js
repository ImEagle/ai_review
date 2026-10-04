#!/usr/bin/env node
'use strict';

// CLI for agent reviewers ("Alice", "Bob", …) to take part in a running review.
//
//   node agent.js --repo PATH --as NAME guide|diff|comment|finish|status [options]
//
// It finds the running review server through <gitDir>/ai-review/session.json.

const fs = require('node:fs');
const path = require('node:path');
const gitlib = require('./git');
const state = require('./state');

const SELF = path.resolve(__filename);

function parseArgs(argv) {
  const o = { _: [] };
  const flags = new Set(['old', 'all', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > 0) o[key] = a.slice(eq + 1);
    else if (flags.has(key)) o[key] = true;
    else o[key] = argv[++i];
  }
  return o;
}

class CliError extends Error {}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function q(s) {
  return /^[\w./:@-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function connect(repo) {
  if (!gitlib.isGitRepo(repo)) throw new CliError(`${repo} is not a git repository. Pass --repo with the path of the project under review.`);
  const root = gitlib.repoRoot(repo);
  const session = state.readSession(gitlib.gitDir(root));
  const none = `No review is running for ${root}. Ask the user to start one (the /review command), then retry.`;
  if (!session) throw new CliError(none);
  try {
    process.kill(session.pid, 0);
  } catch (e) {
    if (e.code === 'ESRCH') throw new CliError(none);
  }
  const call = async (method, urlPath, body) => {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${session.port}${urlPath}`, {
        method,
        headers: { 'X-Agent-Token': session.agentToken, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const code = err.cause?.code || err.code || '';
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') throw new CliError(none);
      // The server is up but we may not reach it: typically an agent sandbox that blocks
      // network access, which also covers 127.0.0.1.
      throw new CliError(
        `A review IS running (pid ${session.pid}), but this process cannot connect to 127.0.0.1:${session.port} ` +
          `(${err.cause?.message || err.message}). Your environment is most likely sandboxed without network access, ` +
          `and that also blocks localhost. Re-run this command with network access allowed, e.g. request escalated ` +
          `permissions / approval to run it outside the sandbox (Codex: or start it with ` +
          `-c sandbox_workspace_write.network_access=true). Every agent.js command needs this.`
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new CliError(data.error || `HTTP ${res.status}`);
    return data;
  };
  return { root, session, call };
}

// ---------------------------------------------------------------------------
// commands

function guide(o) {
  const name = o.as || 'NAME';
  const base = `node ${q(SELF)} --repo ${q(o.repo ? path.resolve(o.repo) : process.cwd())} --as ${q(name)}`;
  return `You are "${name}", an AI code reviewer. You are one of possibly several reviewers (human and AI)
on a set of code changes. The human user makes the final decision and will accept or
reject each of your comments before they go to the agent who wrote the code.

RULES
- Do NOT modify, stage, commit or format any files. You only read and comment.
- These commands talk to the review server on 127.0.0.1. If you run in a sandbox, run them
  with network access allowed (request escalated permissions / approval) or they will fail.
- You may read any file in the repository for context (open files, grep, etc.).
- One issue per comment. Be specific and actionable; say why it matters.
- Focus on: correctness bugs, edge cases, security, data loss, concurrency, error handling,
  API/contract breaks, missing tests, and clearly confusing code. Skip pure style nits
  unless they hide a bug. No praise-only comments.
- Run "status --all" first to avoid duplicating what other reviewers already said.

WORKFLOW
1. Read the changes:
     ${base} diff
   Options: --context 20 (more surrounding lines), --scope working|branch|commits:N.

2. Comment on lines (repeat as needed):
     ${base} comment --file src/app.ts --line 42 --body "Null check missing: user can be undefined here"
   Line range:           --line 42 --end 48
   Deleted ("-") lines:  add --old and use the OLD line number
   Whole file:           omit --line
   Multi-line body:      --body - (reads stdin), e.g.

${base} comment --file src/app.ts --line 42 --body - <<'EOF'
Off-by-one: the loop skips the last element.
\`\`\`suggestion
for (let i = 0; i < items.length; i++) {
\`\`\`
EOF

   A \`\`\`suggestion block must contain the exact replacement for the commented line(s).

3. Finish with your overall verdict (you can re-run it to update):
     ${base} finish --verdict request_changes --summary "Two bugs in error handling; see comments."
   Verdicts: approve | comment | request_changes

4. Check your comments and whether the user accepted them:
     ${base} status        (add --all to include other reviewers)

LINE NUMBERS
In "diff" output every line shows OLD and NEW numbers followed by a marker:
  "+" added line      -> use the NEW number
  "-" deleted line    -> use the OLD number with --old
  " " context line    -> use the NEW number
If a command fails, read the error: it lists the valid lines. Fix the arguments and retry.
`;
}

function formatDiff(res) {
  const out = [`Reviewing ${res.label}. ${res.files.length} file(s) changed.`, ''];
  for (const f of res.files) {
    const what = f.status === 'renamed' ? `renamed from ${f.oldPath}` : f.status;
    out.push(`=== ${f.path} (${what}, +${f.additions} -${f.deletions}) ===`);
    if (f.binary) {
      out.push('(binary file, not shown)', '');
      continue;
    }
    if (!f.hunks.length) {
      out.push('(no content changes)', '');
      continue;
    }
    out.push('  OLD   NEW');
    for (const h of f.hunks) {
      out.push(h.header);
      for (const l of h.lines) {
        const mark = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        out.push(`${String(l.oldNo ?? '').padStart(5)} ${String(l.newNo ?? '').padStart(5)} ${mark} ${l.text}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

function rangeLabel(c) {
  if (c.start == null) return 'file-level';
  const r = c.end !== c.start ? `L${c.start}–L${c.end}` : `L${c.start}`;
  return c.side === 'old' ? `${r} (old)` : r;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0] || (o.help ? 'guide' : '');
  o.repo = o.repo || process.cwd();
  o.as = o.as || process.env.AI_REVIEW_AS;

  if (!cmd || cmd === 'guide' || cmd === 'help') {
    console.log(guide(o));
    return;
  }
  if (!o.as) throw new CliError('Pass your reviewer name with --as NAME.');
  const { call } = connect(path.resolve(o.repo));

  if (cmd === 'diff') {
    await call('POST', '/agent-api/join', { name: o.as });
    const params = new URLSearchParams();
    if (o.scope) params.set('scope', o.scope);
    if (o.context) params.set('context', o.context);
    console.log(formatDiff(await call('GET', `/agent-api/diff?${params}`)));
  } else if (cmd === 'comment') {
    let body = o.body === '-' ? readStdin() : o.body;
    if (!body || !String(body).trim()) throw new CliError('Missing --body TEXT (or --body - to read it from stdin).');
    if (!o.file) throw new CliError('Missing --file PATH (relative to the repository root).');
    const c = await call('POST', '/agent-api/comment', {
      name: o.as,
      file: o.file,
      start: o.line ?? null,
      end: o.end ?? o.line ?? null,
      side: o.old ? 'old' : 'new',
      scope: o.scope,
      body,
    });
    console.log(`Added comment ${c.id} on ${c.file} ${rangeLabel(c)}.`);
  } else if (cmd === 'finish') {
    const summary = o.summary === '-' ? readStdin() : o.summary || '';
    const r = await call('POST', '/agent-api/finish', { name: o.as, verdict: o.verdict, summary });
    console.log(`Recorded verdict "${r.verdict}" for ${r.name}. The user will make the final decision.`);
  } else if (cmd === 'status') {
    const params = new URLSearchParams({ name: o.as });
    if (o.all) params.set('all', '1');
    const comments = await call('GET', `/agent-api/comments?${params}`);
    if (!comments.length) console.log(o.all ? 'No agent comments yet.' : `${o.as} has no comments yet.`);
    for (const c of comments) {
      const firstLine = c.body.split('\n')[0];
      console.log(`[${c.status}] ${c.id} ${o.all ? `${c.author} ` : ''}${c.file} ${rangeLabel(c)}: ${firstLine.length > 100 ? firstLine.slice(0, 99) + '…' : firstLine}`);
    }
  } else {
    throw new CliError(`Unknown command "${cmd}". Commands: guide, diff, comment, finish, status.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ai-review: ${err.message}`);
    process.exit(err instanceof CliError ? 2 : 1);
  });
}

module.exports = { parseArgs, formatDiff };
