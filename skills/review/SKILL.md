---
name: review
description: Open a GitHub-style review UI in the browser for the user to review the code changes (diff), leave inline comments, and send them back for you to address. Use when the user says "/review", "let me review", "I want to review the changes/diff", or asks to review your work before continuing.
argument-hint: "[working | branch | commits:N]"
allowed-tools: Bash(node:*)
---

# Interactive code review

The user wants to review your changes in a GitHub-style diff viewer, then hand comments back to you.

## 1. Launch the review UI

Run this with the Bash tool and **`run_in_background: true`** (the user may take a long time; a foreground call would time out):

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/review.js" $ARGUMENTS
```

Arguments (optional): `working` (default, all uncommitted changes incl. untracked files), `branch` (branch vs main/master incl. uncommitted), `commits:N` (last N commits). The user can also switch scope inside the UI.

## 2. Tell the user where to look

Read the background task's output once; the first line is `Review UI: http://127.0.0.1:…`. The browser opens automatically. Reply with one short line containing that URL, e.g. "Review UI is open at <url>. Submit the review when you're done and I'll pick up your comments." Then **end your turn and wait**. Do not poll, do not sleep, do not start other work. You are notified when the process exits.

## 3. Handle the result

When notified, read the task output. Everything after `=== REVIEW SUBMITTED ===` is the review in markdown: a verdict, an optional general comment, and comments grouped by file with line numbers and the code snippet each comment refers to.

- **`=== REVIEW CANCELLED ===` / `=== REVIEW TIMED OUT ===`**: tell the user in one line; do nothing else.
- **APPROVED with no comments**: acknowledge briefly; you're done.
- **Otherwise**: address *every* comment.
  - Line numbers refer to the reviewed diff. If code has moved, locate it using the quoted snippet.
  - A `suggestion` block is the exact replacement the reviewer wants for the commented lines. Apply it as-is unless it is clearly broken.
  - Comments marked `(old)` are about deleted lines (e.g. "don't remove this").
  - If a comment is a question, answer it; change code only if the answer implies a change.
  - If a comment is ambiguous or you disagree, say so instead of guessing.
- Finish with a checklist mapping each comment (`file:Lx`) to what you did, then offer another review round (`/ai-review:review`).
