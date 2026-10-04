'use strict';

// Named agent reviewers ("Alice", "Bob", …): their comments, verdicts and the
// user's accept/reject decisions on them.

const crypto = require('node:crypto');
const path = require('node:path');
const gitlib = require('./git');
const state = require('./state');

const VERDICTS = ['approve', 'comment', 'request_changes'];
const STATUSES = ['pending', 'accepted', 'rejected'];
const STANCES = ['info', 'agree', 'disagree'];
const AGENT_CLI = path.join(__dirname, 'agent.js');

class InputError extends Error {}

function cleanName(name) {
  const n = String(name || '').trim();
  if (!n) throw new InputError('A reviewer name is required (--as NAME).');
  if (n.length > 40) throw new InputError('Reviewer name is too long (max 40 characters).');
  if (/^(you|user|me)$/i.test(n)) throw new InputError(`"${n}" is reserved for the human reviewer; pick another name.`);
  if (/[\r\n"`$\\]/.test(n)) throw new InputError('Reviewer name must not contain quotes, backticks, $, backslashes or newlines.');
  return n;
}

/** The text the user pastes into another agent to make it a reviewer. */
function agentPrompt(root, name = 'NAME') {
  return `You are code reviewer "${name}". Review the code changes in ${root}. Run: node "${AGENT_CLI}" --repo "${root}" --as "${name}" guide — then follow its instructions. (agent.js talks to a local server on 127.0.0.1: if your shell is sandboxed, run it with network access allowed.)`;
}

class ReviewerStore {
  constructor({ root, gitDir, scope, onChange = () => {} }) {
    this.root = root;
    this.gitDir = gitDir;
    this.scope = scope;
    this.onChange = onChange;
    this.data = state.readAgents(gitDir);
    // Reviewer names are user input ("__proto__", "constructor", …): keep them in a prototype-less map.
    this.data.reviewers = Object.assign(Object.create(null), this.data.reviewers);
  }

  snapshot() {
    return { reviewers: Object.values(this.data.reviewers), comments: this.data.comments };
  }

  save() {
    state.writeAgents(this.gitDir, this.data);
    this.onChange(this.snapshot());
  }

  join(rawName) {
    const name = cleanName(rawName);
    const now = new Date().toISOString();
    if (!this.data.reviewers[name]) {
      this.data.reviewers[name] = { name, verdict: null, summary: '', summaryStatus: 'pending', joinedAt: now, updatedAt: now };
      this.save();
    }
    return this.data.reviewers[name];
  }

  addComment(rawName, input) {
    const name = cleanName(rawName);
    const body = String(input.body || '').trim();
    if (!body) throw new InputError('Comment body is empty.');
    const scope = input.scope || this.scope;
    const side = input.side === 'old' ? 'old' : 'new';
    const filePath = String(input.file || '').replace(/^\.\//, '');

    // Validate against the full-context diff so comments on unchanged lines of a changed file work too.
    const files = gitlib.getDiff(this.root, scope, { context: 'all' }).files;
    const file = files.find((f) => f.path === filePath || f.newPath === filePath || f.oldPath === filePath);
    if (!file) {
      const names = files.map((f) => f.path);
      throw new InputError(`"${filePath}" is not part of the reviewed changes. Changed files: ${names.join(', ') || '(none)'}`);
    }

    let start = input.start == null || input.start === '' ? null : parseInt(input.start, 10);
    let end = input.end == null || input.end === '' ? start : parseInt(input.end, 10);
    if (start != null) {
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new InputError('Line numbers must be integers.');
      if (end < start) [start, end] = [end, start];
      const lines = gitlib.sideLines(file, side);
      for (const n of [start, end]) {
        if (!lines.has(n)) {
          const hint = side === 'new' ? 'Use NEW numbers for "+" and context lines, or --old with OLD numbers for "-" lines.' : 'With --old, use OLD numbers of "-" or context lines.';
          throw new InputError(`Line ${n} is not on the ${side} side of ${file.path} (available: ${gitlib.describeRanges(lines.keys()) || 'none'}). ${hint}`);
        }
      }
    }

    // Steer agents to reply instead of repeating another reviewer's point on the same lines.
    if (!input.newIssue) {
      const overlaps = (c) =>
        c.start == null || start == null ? c.start == null && start == null : c.side === side && c.start <= end && start <= c.end;
      const others = this.data.comments.filter((c) => !c.parentId && c.author !== name && c.file === file.path && c.scope === scope && overlaps(c));
      if (others.length) {
        const list = others
          .map((c) => `  [${c.id}] ${c.author} on ${c.start == null ? 'the file' : `L${c.start}${c.end !== c.start ? `–L${c.end}` : ''}`}: ${c.body.split('\n')[0].slice(0, 120)}`)
          .join('\n');
        throw new InputError(
          `Other reviewers already commented on these lines:\n${list}\n` +
            `If you are making the same point, or want to agree, disagree or add context, use "reply --to ID" instead. ` +
            `If this is a genuinely different issue, re-run the same command with --new-issue.`
        );
      }
    }

    this.join(name);
    const comment = {
      id: crypto.randomBytes(4).toString('hex'),
      author: name,
      scope,
      file: file.path,
      side,
      start,
      end: start == null ? null : end,
      body,
      snippet: start == null ? [] : gitlib.snippetFor(file, side, start, end),
      lang: gitlib.langFor(file.path),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.data.comments.push(comment);
    this.data.reviewers[name].updatedAt = comment.createdAt;
    this.save();
    return comment;
  }

  /** A reply to another comment. Threads are one level deep: replying to a reply attaches to its root. */
  addReply(rawName, parentId, rawBody, rawStance = 'info') {
    const name = cleanName(rawName);
    const body = String(rawBody || '').trim();
    if (!body) throw new InputError('Reply body is empty.');
    const stance = rawStance || 'info';
    if (!STANCES.includes(stance)) throw new InputError(`Stance must be one of: ${STANCES.join(', ')}.`);
    const parent = this.data.comments.find((c) => c.id === String(parentId || '').trim());
    if (!parent) {
      const ids = this.data.comments.map((c) => `${c.id} (${c.author})`).join(', ');
      throw new InputError(`No comment with id "${parentId}". Run "comments" to see the ids. Existing: ${ids || '(none)'}`);
    }
    const root = parent.parentId ? this.data.comments.find((c) => c.id === parent.parentId) || parent : parent;

    this.join(name);
    const reply = {
      id: crypto.randomBytes(4).toString('hex'),
      parentId: root.id,
      inReplyTo: parent.id,
      stance,
      author: name,
      scope: root.scope,
      file: root.file,
      side: root.side,
      start: root.start,
      end: root.end,
      body,
      snippet: [],
      lang: root.lang,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.data.comments.push(reply);
    this.data.reviewers[name].updatedAt = reply.createdAt;
    this.save();
    return reply;
  }

  /** What goes to the implementing agent: nothing rejected, and nothing in a rejected thread. */
  sendable() {
    const byId = new Map(this.data.comments.map((c) => [c.id, c]));
    return this.data.comments.filter((c) => {
      if (c.status === 'rejected') return false;
      const root = c.parentId && byId.get(c.parentId);
      return !root || root.status !== 'rejected';
    });
  }

  finish(rawName, verdict, summary = '') {
    if (!VERDICTS.includes(verdict)) throw new InputError(`Verdict must be one of: ${VERDICTS.join(', ')}.`);
    const r = this.join(rawName);
    r.verdict = verdict;
    r.summary = String(summary || '').trim();
    r.summaryStatus = 'pending';
    r.updatedAt = new Date().toISOString();
    this.save();
    return r;
  }

  setStatus(id, status) {
    if (!STATUSES.includes(status)) throw new InputError(`Status must be one of: ${STATUSES.join(', ')}.`);
    const c = this.data.comments.find((x) => x.id === id);
    if (!c) throw new InputError(`No agent comment ${id}.`);
    c.status = status;
    this.save();
    return c;
  }

  // "Accept all pending" leaves decided comments alone; "Reject all" rejects every comment of that reviewer.
  bulk(author, status, onlyPending = status !== 'rejected') {
    if (!STATUSES.includes(status)) throw new InputError(`Status must be one of: ${STATUSES.join(', ')}.`);
    for (const c of this.data.comments) {
      if (c.author === author && (!onlyPending || c.status === 'pending')) c.status = status;
    }
    this.save();
  }

  setSummaryStatus(name, status) {
    if (!STATUSES.includes(status)) throw new InputError(`Status must be one of: ${STATUSES.join(', ')}.`);
    const r = this.data.reviewers[name];
    if (!r) throw new InputError(`No reviewer ${name}.`);
    r.summaryStatus = status;
    this.save();
  }

  commentsFor(name) {
    return this.data.comments.filter((c) => !name || c.author === name);
  }

  clear() {
    this.data = { reviewers: Object.create(null), comments: [] };
    state.clearAgents(this.gitDir);
  }
}

module.exports = { ReviewerStore, InputError, agentPrompt, cleanName, VERDICTS, STANCES, AGENT_CLI };
