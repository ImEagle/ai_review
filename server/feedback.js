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
  const files = [...new Set(comments.map((c) => c.file))].sort();
  const reviewers = (review.reviewers || []).filter((r) => r.verdict || r.summary || comments.some((c) => c.author === r.name));
  const multi = comments.some((c) => c.author);
  const byWhom = (c) => (multi ? ` · ${c.author || 'user'}` : '');
  const summaries = reviewers.some((r) => r.summary);

  const out = [];
  out.push(`# Code review — ${VERDICT_TITLES[verdict] || verdict.toUpperCase()}`);
  const stats = [scopeLabel && `Scope: ${scopeLabel}`, `${comments.length} comment${comments.length === 1 ? '' : 's'}`, files.length && `${files.length} file${files.length === 1 ? '' : 's'}`].filter(Boolean);
  out.push(stats.join(' · '));

  if (general) {
    out.push('', multi ? '## General (user)' : '## General', '', quote(general));
  }

  if (reviewers.length) {
    out.push('', '## Agent reviewers');
    for (const r of reviewers) {
      const n = comments.filter((c) => c.author === r.name).length;
      const v = r.verdict ? VERDICT_TITLES[r.verdict] || r.verdict : 'no verdict';
      out.push(`- **${r.name}** — ${v}, ${n} comment${n === 1 ? '' : 's'} kept${r.summary ? ':' : ''}`);
      if (r.summary) out.push(quote(r.summary).replace(/^/gm, '  '));
    }
  }

  for (const file of files) {
    out.push('', `## ${file}`);
    const fileComments = comments
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
    }
  }

  const hasSuggestion = comments.some((c) => /```suggestion/.test(c.body));
  out.push('', '---');
  if (multi || summaries) {
    out.push('Comments and summaries by named agent reviewers were vetted by the user (rejected ones were removed); treat them all as the user\'s feedback.');
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
