'use strict';

const { execFileSync } = require('node:child_process');

// Hash of the empty tree; lets us diff against "nothing" in a repo without commits.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_BUFFER = 256 * 1024 * 1024;

function git(cwd, args, { okCodes = [0] } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (typeof err.status === 'number' && okCodes.includes(err.status)) return err.stdout || '';
    const msg = (err.stderr || err.message || '').toString().trim();
    const e = new Error(`git ${args.join(' ')} failed: ${msg}`);
    e.status = err.status;
    throw e;
  }
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

function isGitRepo(cwd) {
  return tryGit(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

function gitDir(cwd) {
  return git(cwd, ['rev-parse', '--absolute-git-dir']).trim();
}

function hasHead(cwd) {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null;
}

function currentBranch(cwd) {
  return tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']) || tryGit(cwd, ['rev-parse', '--short', 'HEAD']) || '(no commits)';
}

function detectBase(cwd) {
  const candidates = ['refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
  for (const ref of candidates) {
    if (tryGit(cwd, ['rev-parse', '--verify', '--quiet', ref]) !== null) return ref.replace(/^refs\/(heads|remotes)\//, '');
  }
  const originHead = tryGit(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  return originHead || null;
}

function recentCommits(cwd, limit = 20) {
  if (!hasHead(cwd)) return [];
  const out = tryGit(cwd, ['log', `-${limit}`, '--format=%h%x09%s']) || '';
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, ...rest] = l.split('\t');
    return { sha, subject: rest.join('\t') };
  });
}

function getScopes(cwd) {
  const branch = currentBranch(cwd);
  const base = detectBase(cwd);
  const scopes = [{ id: 'working', label: 'Uncommitted changes (working tree vs HEAD)' }];
  if (base && hasHead(cwd)) scopes.push({ id: 'branch', label: `Branch vs ${base} (incl. uncommitted)` });
  return { branch, base, scopes, commits: recentCommits(cwd) };
}

function scopeLabel(cwd, scope) {
  if (scope === 'working') return 'uncommitted changes (working tree vs HEAD)';
  if (scope === 'branch') return `branch ${currentBranch(cwd)} vs ${detectBase(cwd)} (incl. uncommitted)`;
  const m = /^commits:(\d+)$/.exec(scope);
  if (m) return `last ${m[1]} commit${m[1] === '1' ? '' : 's'}`;
  return scope;
}

function untrackedDiff(cwd, contextArgs) {
  const list = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  let out = '';
  for (const file of list) {
    // --no-index exits 1 when the files differ, which is always the case here.
    out += git(cwd, ['diff', '--no-color', '--no-ext-diff', ...contextArgs, '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] });
  }
  return out;
}

/**
 * Returns the raw unified diff for a scope.
 *   working    – everything uncommitted (staged + unstaged + untracked) vs HEAD
 *   branch     – merge-base(base, HEAD) vs working tree (+ untracked)
 *   commits:N  – HEAD~N vs HEAD
 */
function getRawDiff(cwd, scope = 'working', { context = 3 } = {}) {
  const ctx = context === 'all' ? 100000 : Math.max(0, parseInt(context, 10) || 3);
  const contextArgs = [`-U${ctx}`];
  const common = ['diff', '--no-color', '--no-ext-diff', '-M', ...contextArgs];

  if (scope === 'working') {
    const from = hasHead(cwd) ? 'HEAD' : EMPTY_TREE;
    return git(cwd, [...common, from]) + untrackedDiff(cwd, contextArgs);
  }
  if (scope === 'branch') {
    const base = detectBase(cwd);
    if (!base) throw new Error('No base branch (main/master) found');
    const mb = git(cwd, ['merge-base', base, 'HEAD']).trim();
    return git(cwd, [...common, mb]) + untrackedDiff(cwd, contextArgs);
  }
  const m = /^commits:(\d+)$/.exec(scope);
  if (m) {
    const n = parseInt(m[1], 10);
    const total = parseInt(git(cwd, ['rev-list', '--count', 'HEAD']).trim(), 10);
    const from = n >= total ? EMPTY_TREE : `HEAD~${n}`;
    return git(cwd, [...common, from, 'HEAD']);
  }
  throw new Error(`Unknown scope: ${scope}`);
}

function getDiff(cwd, scope = 'working', opts = {}) {
  const raw = getRawDiff(cwd, scope, opts);
  return { scope, label: scopeLabel(cwd, scope), files: parseUnifiedDiff(raw) };
}

// ---------------------------------------------------------------------------
// Unified diff parser

function unquote(p) {
  if (!p.startsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[++i];
    const simple = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
    if (n in simple) bytes.push(simple[n]);
    else if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.substr(i, 3), 8));
      i += 2;
    } else bytes.push(n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p) {
  p = unquote(p.trim());
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

function pathsFromGitHeader(rest) {
  // rest: `a/foo b/foo`, possibly quoted.
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted && (rest.startsWith('"') || rest.endsWith('"'))) return [stripPrefix(quoted[1]), stripPrefix(quoted[2])];
  const L = (rest.length - 5) / 2;
  if (Number.isInteger(L) && L > 0 && rest.slice(2, 2 + L) === rest.slice(5 + L)) {
    const p = rest.slice(2, 2 + L);
    return [p, p];
  }
  const parts = rest.split(' b/');
  return [stripPrefix(parts[0]), stripPrefix('b/' + parts.slice(1).join(' b/'))];
}

function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const [a, b] = pathsFromGitHeader(line.slice('diff --git '.length));
      file = { oldPath: a, newPath: b, status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m) continue;
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[3], 10);
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.oldPath = unquote(line.slice(12)); file.status = 'renamed'; }
      else if (line.startsWith('rename to ')) file.newPath = unquote(line.slice(10));
      else if (line.startsWith('copy from ')) { file.oldPath = unquote(line.slice(10)); file.status = 'copied'; }
      else if (line.startsWith('copy to ')) file.newPath = unquote(line.slice(8));
      else if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4));
        if (p === null) file.status = 'added';
        else file.oldPath = p;
      } else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4));
        if (p === null) file.status = 'deleted';
        else file.newPath = p;
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
      continue;
    }

    const c = line[0];
    if (c === '+') {
      hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
      file.additions++;
    } else if (c === '-') {
      hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
      file.deletions++;
    } else if (c === '\\') {
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noNewline = true;
    } else {
      hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
  }

  for (const f of files) {
    if (f.status === 'added') f.oldPath = null;
    if (f.status === 'deleted') f.newPath = null;
    f.path = f.newPath || f.oldPath;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Line helpers shared by the agent API and the feedback formatter

/** Line numbers addressable on one side of a parsed file ('new' = added + context, 'old' = deleted + context). */
function sideLines(file, side) {
  const out = new Map();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      const no = side === 'old' ? (l.type === 'add' ? null : l.oldNo) : l.type === 'del' ? null : l.newNo;
      if (no != null) out.set(no, l.text);
    }
  }
  return out;
}

function snippetFor(file, side, start, end, max = 80) {
  const lines = sideLines(file, side);
  const out = [];
  for (let n = start; n <= end && out.length < max; n++) if (lines.has(n)) out.push(lines.get(n));
  return out;
}

/** Compresses [1,2,3,7,8] into "1–3, 7–8". */
function describeRanges(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

const EXT_LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json',
  yml: 'yaml', yaml: 'yaml', md: 'markdown', html: 'html', css: 'css', scss: 'scss', sql: 'sql', lua: 'lua',
};

function langFor(p) {
  return EXT_LANGS[(p || '').split('.').pop().toLowerCase()] || '';
}

module.exports = {
  sideLines,
  snippetFor,
  describeRanges,
  langFor,
  EMPTY_TREE,
  git,
  isGitRepo,
  repoRoot,
  gitDir,
  hasHead,
  currentBranch,
  detectBase,
  getScopes,
  scopeLabel,
  getRawDiff,
  getDiff,
  parseUnifiedDiff,
};
