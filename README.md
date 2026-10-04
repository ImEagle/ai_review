# ai-review

A Claude Code plugin for reviewing the agent's changes the way you review a pull request on GitHub, then sending your comments back so the agent can address them.

- A file tree, plus **split** or **unified** diffs with syntax highlighting
- **Inline comments** on one line or a range (drag, or shift-click, on the `+` or a line number), **file-level** comments, and a **general** comment
- **Suggestions**: a `suggestion` block pre-filled with the selected lines
- **Viewed** checkboxes, a filter, and a choice of how much context to show (3, 10 or 25 lines, or full files)
- Scope picker: uncommitted changes (the default, including untracked files), branch vs `main`/`master`, or the last N commits
- Verdicts: **Comment**, **Approve**, or **Request changes**
- Drafts are saved automatically, so a browser refresh doesn't lose your comments. Each round is kept in history, and the next round shows the previous round's comments.

Runs locally with no dependencies: Node ≥ 18 and git. The server listens only on `127.0.0.1` and requires a per-session token. highlight.js is loaded from cdnjs; without network access, diffs are shown without syntax colours.

## Install

```bash
# try it for one session
claude --plugin-dir /path/to/ai_review

# or install it permanently through the bundled local marketplace
/plugin marketplace add /path/to/ai_review
/plugin install ai-review@ai-review-local
```

## Use

### On demand

```
/ai-review:review               # uncommitted changes
/ai-review:review branch        # branch vs main/master
/ai-review:review commits:3     # last 3 commits
```

Claude starts the review UI in the background and gives you the URL; the browser opens automatically. Review the diff, then click **Finish review → Submit**. Claude receives the review as structured markdown: comments grouped by file, with line numbers and the commented code. It addresses each comment and replies with a checklist.

### Automatically after every turn (optional)

```
/ai-review:review-auto on     # off | status
```

With auto review on, a Stop hook opens the review UI whenever Claude finishes a turn that left **new** uncommitted changes, and Claude waits for you:

- **Approve**, closing without submitting, or a timeout (55 min): Claude stops normally.
- **Comment** or **Request changes**: the feedback goes straight back to Claude, which keeps working. When Claude stops again, the next round opens.

A diff you have already reviewed never opens the UI again, so the loop always ends. When you turn auto review on, any changes that already exist count as reviewed.

## Standalone

```bash
node server/review.js [working|branch|commits:N] [--port N] [--no-open] [--timeout MIN]
```

The review is printed to stdout when you submit.

## Where state lives

Everything is stored in `.git/ai-review/`, so it never shows up in the diff:

| File | Purpose |
|---|---|
| `draft.json` | comments in progress |
| `history/*.json` | submitted reviews (the latest one is shown as "Previous round") |
| `auto` | auto-review flag |
| `last-reviewed` | hash of the last reviewed diff (used by the hook) |

Environment variables: `AI_REVIEW_NO_OPEN=1` stops the browser from opening; `AI_REVIEW_HOOK_TIMEOUT=<min>` sets how long the hook waits.

## Development

```bash
npm test
```
