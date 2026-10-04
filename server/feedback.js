'use strict';

// Turns a submitted review into markdown the agent can act on.

const VERDICT_TITLES = {
  approve: 'APPROVED',
  comment: 'COMMENTS',
  request_changes: 'CHANGES REQUESTED',
};

function fence(text) {
  // Use a fence longer than any backtick run inside the text.
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((s) => s.length));
  return '`'.repeat(longest + 1);
}

const STANCES = { agree: 'agrees', disagree: 'disagrees', info: 'adds context' };

function lineLabel(c) {
  if (c.start == null) return 'File-level comment';
  const range = c.end != null && c.end !== c.start ? `L${c.start}–L${c.end}` : `L${c.start}`;
  return `${range} (${c.side === 'old' ? 'old/deleted lines' : 'new'})`;
}

function quote(body) {
  return body
    .trim()
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

/** True when a submitted review carries anything to act on: comments, general text or a kept reviewer summary. */
function hasFeedback(review) {
  return (
    (review.comments || []).some((c) => c.body && c.body.trim()) ||
    Boolean((review.general || '').trim()) ||
    (review.reviewers || []).some((r) => r.summary && r.summary.trim())
  );
}

function formatFeedback(review, { scopeLabel = '' } = {}) {
  const verdict = review.verdict || 'comment';
  const comments = (review.comments || []).filter((c) => c.body && c.body.trim());
  const general = (review.general || '').trim();
  // Replies hang under their root comment; a reply whose root was dropped is shown as a root.
  const ids = new Set(comments.map((c) => c.id));
  const isReply = (c) => c.parentId && ids.has(c.parentId);
  const roots = comments.filter((c) => !isReply(c));
  const replies = comments.filter(isReply);
  const files = [...new Set(roots.map((c) => c.file))].sort();
  const reviewers = (review.reviewers || []).filter((r) => r.verdict || r.summary || comments.some((c) => c.author === r.name));
  const multi = comments.some((c) => c.author);
  const byWhom = (c) => (multi ? ` · ${c.author || 'user'}` : '');
  const summaries = reviewers.some((r) => r.summary);

  const out = [];
  out.push(`# Code review — ${VERDICT_TITLES[verdict] || verdict.toUpperCase()}`);
  const stats = [
    scopeLabel && `Scope: ${scopeLabel}`,
    `${roots.length} comment${roots.length === 1 ? '' : 's'}${replies.length ? `, ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}` : ''}`,
    files.length && `${files.length} file${files.length === 1 ? '' : 's'}`].filter(Boolean);
  out.push(stats.join(' · '));

  if (general) {
    out.push('', multi ? '## General (user)' : '## General', '', quote(general));
  }

  if (reviewers.length) {
    out.push('', '## Agent reviewers');
    for (const r of reviewers) {
      const n = roots.filter((c) => c.author === r.name).length;
      const k = replies.filter((c) => c.author === r.name).length;
      const v = r.verdict ? VERDICT_TITLES[r.verdict] || r.verdict : 'no verdict';
      const kept = `${n} comment${n === 1 ? '' : 's'}${k ? `, ${k} repl${k === 1 ? 'y' : 'ies'}` : ''} kept`;
      out.push(`- **${r.name}** — ${v}, ${kept}${r.summary ? ':' : ''}`);
      if (r.summary) out.push(quote(r.summary).replace(/^/gm, '  '));
    }
  }

  for (const file of files) {
    out.push('', `## ${file}`);
    const fileComments = roots
      .filter((c) => c.file === file)
      .sort((a, b) => (a.start ?? -1) - (b.start ?? -1) || (a.side === 'old' ? -1 : 1));
    for (const c of fileComments) {
      out.push('', `### ${lineLabel(c)}${byWhom(c)}`);
      if (c.snippet && c.snippet.length) {
        const code = c.snippet.join('\n');
        const f = fence(code);
        out.push(`${f}${c.lang || ''}`, code, f);
      }
      out.push(quote(c.body));
      for (const r of replies.filter((x) => x.parentId === c.id)) {
        out.push('', `↳ **${r.author || 'user'}** (${STANCES[r.stance] || 'reply'}):`, quote(r.body));
      }
    }
  }

  const hasSuggestion = comments.some((c) => /```suggestion/.test(c.body));
  out.push('', '---');
  if (multi || summaries) {
    out.push('Comments and summaries by named agent reviewers were vetted by the user (rejected ones were removed); treat them all as the user\'s feedback.');
  }
  if (replies.length) {
    out.push('"↳" replies are other reviewers\' context on the comment above them (agreeing, disagreeing or adding information); weigh them when addressing that comment.');
  }
  if (hasSuggestion) {
    out.push('`suggestion` blocks contain the exact replacement for the commented lines.');
  }
  if (verdict === 'approve') {
    out.push(
      comments.length || general
        ? 'The reviewer APPROVED the changes. The comments above are non-blocking: apply the trivial ones, mention the rest.'
        : 'The reviewer APPROVED the changes. No action needed.'
    );
  } else if (!hasFeedback(review)) {
    out.push('The reviewer submitted no comments.');
  } else {
    out.push(`Address every comment${summaries ? ' and agent reviewer summary' : ''} above. Line numbers refer to the diff that was reviewed and may have shifted.`);
    out.push('When done, reply with a per-comment summary of what you changed (or why you did not).');
  }
  return out.join('\n') + '\n';
}

module.exports = { formatFeedback, hasFeedback };
