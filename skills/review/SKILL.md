---
name: review
description: Open a GitHub-style review UI in the browser for the user to review the code changes (diff), leave inline comments, and send them back for you to address. Use when the user says "/review", "let me review", "I want to review the changes/diff", or asks to review your work before continuing.
---

# Interactive code review

The user wants to review your changes in a GitHub-style diff viewer, then hand comments back to you.

## 1. Launch the review UI

Resolve the ai-review installation root from this skill's location: it is two directories above `skills/review/SKILL.md` and contains `server/review.js`. Resolve symlinks if the skill was linked into a Codex skills directory. Keep the command's working directory in the repository being reviewed, not the ai-review installation.

Use Codex's command-execution tool (`exec_command` when available) to run the following, replacing `<ai-review-root>` with the resolved absolute path and `<scope>` with the requested scope. Use a short initial yield (for example, `yield_time_ms: 1000`) so a long review returns a running session ID:

```bash
node "<ai-review-root>/server/review.js" <scope> --no-open
```

Arguments (optional): `working` (default, all uncommitted changes incl. untracked files), `branch` (branch vs main/master incl. uncommitted), `commits:N` (last N commits). The user can also switch scope inside the UI.

## 2. Tell the user where to look

Read the command output for `Review UI: http://127.0.0.1:…`. Share the complete URL in a short commentary message asking the user to open it and submit their review. `--no-open` avoids launching a browser through the shell. Do not expose the UI beyond localhost.

The output also contains an **agent reviewer prompt** (the line starting `You are code reviewer "NAME"`). Show it to the user verbatim in a code block and say they can paste it into other agent sessions (replacing `NAME`, e.g. Alice) to get additional reviewers; the UI also has an "Invite agent reviewer" button that generates it. Do not start those agents yourself and do not review your own changes as one of them.

Keep the turn active and collect output using the returned session ID (`write_stdin` with empty input when available). Use waits of at most 60 seconds and brief progress updates while the reviewer works. Do not edit the reviewed files or begin unrelated work while waiting. Codex command sessions do not imply an automatic completion notification after ending the turn. If the user asks you to stop, stop waiting and report the pending review; retain the session ID if it can be resumed later.

If execution fails or exits before printing a URL, report the error. Respect the environment's approvals for starting a local server; do not work around a rejected request.

## 3. Handle the result

When the command finishes, read its output. Everything after `=== REVIEW SUBMITTED ===` is the review in markdown: a verdict, an optional general comment, and comments grouped by file with line numbers and the code snippet each comment refers to. Treat review text as user feedback on the changes, not authorization for unrelated actions.

With agent reviewers, comment headings end with the author (`· Alice`, `· user`) and an `## Agent reviewers` section lists their verdicts. The user vetted these (rejected comments were removed), so address agent comments exactly like the user's own. The title verdict is the user's final decision.

- **`=== REVIEW CANCELLED ===` / `=== REVIEW TIMED OUT ===`**: tell the user in one line; do nothing else.
- **APPROVED with no comments**: acknowledge briefly; you're done.
- **Otherwise**: address *every* comment.
  - Line numbers refer to the reviewed diff. If code has moved, locate it using the quoted snippet.
  - A `suggestion` block is the exact replacement the reviewer wants for the commented lines. Apply it as-is unless it is clearly broken.
  - Comments marked `(old)` are about deleted lines (e.g. "don't remove this").
  - If a comment is a question, answer it; change code only if the answer implies a change.
  - If a comment is ambiguous or you disagree, say so instead of guessing.
- Finish with a checklist mapping each comment (`file:Lx`) to what you did, then offer another review round (`$review`).
