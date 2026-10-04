# ai-review

Skills for Codex and a Claude Code plugin for reviewing the agent's changes the way you review a pull request on GitHub, then sending your comments back so the agent can address them.

- A file tree, plus **split** or **unified** diffs with syntax highlighting
- **Inline comments** on one line or a range: select code text and click the floating **Comment** button, or drag / shift-click the `+` or a line number. Also **file-level** comments and a **general** comment
- **Suggestions**: a `suggestion` block pre-filled with the selected lines
- **Viewed** checkboxes, a filter, and a choice of how much context to show (3, 10 or 25 lines, or full files)
- Scope picker: uncommitted changes (the default, including untracked files), branch vs `main`/`master`, or the last N commits
- Verdicts: **Comment**, **Approve**, or **Request changes**
- **Agent reviewers**: invite other agents by name (e.g. "Alice") to comment on the same diff. Their comments appear live, and you **accept** or **reject** each one before your final approval
- Drafts are saved automatically, so a browser refresh doesn't lose your comments. Each round is kept in history, and the next round shows the previous round's comments.

Runs locally with no dependencies: Node ≥ 18 and git. The server listens only on `127.0.0.1` and requires a per-session token. highlight.js is loaded from cdnjs; without network access, diffs are shown without syntax colours.

## Install

### Codex

Link the skills into your personal skills directory, keeping this checkout in place because the skills use its server and UI:

```bash
mkdir -p ~/.agents/skills
ln -s /absolute/path/to/ai_review/skills/review ~/.agents/skills/review
ln -s /absolute/path/to/ai_review/skills/review-auto ~/.agents/skills/review-auto
```

For repository-only discovery, use that repository's `.agents/skills` instead. Codex supports symlinked skills and `$skill-name` invocation; see the [official skill documentation](https://learn.chatgpt.com/docs/build-skills).

In Codex, invoke:

```text
$review
$review branch
$review commits:3
$review-auto on             # off | status
```

Codex shares a localhost URL for you to open, waits in the active command session, and addresses submitted feedback. Per-turn review runs the existing diff check before Codex finishes work while the skill instructions remain active in the conversation. It does not install a Codex runtime hook; the persisted repository flag alone does not enable review in another conversation. `$review-auto` is explicit-only, preserving the original skill's invocation policy.

### Claude Code

```bash
# try it for one session
claude --plugin-dir /path/to/ai_review

# or install it permanently through the bundled local marketplace
/plugin marketplace add /path/to/ai_review
/plugin install ai-review@ai-review-local
```

## Claude Code use

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

## Agent reviewers (multiple reviewers)

Other agents can review the same changes alongside you, each under its own name. When a review starts, the command output (and the UI's **+ Invite agent reviewer** form) gives you a prompt to paste into another agent session, such as Claude Code, Codex or Gemini:

```text
You are code reviewer "Alice". Review the code changes in /path/to/repo. Run: node "/path/to/ai_review/server/agent.js" --repo "/path/to/repo" --as "Alice" guide — then follow its instructions.
```

The `guide` command teaches the agent the workflow: `diff` to read numbered changes, `comment --file F --line N [--end M] [--old] --body TEXT` to comment, `finish --verdict approve|comment|request_changes --summary TEXT` to give its verdict, and `status` to see your decisions. Agents can only read and comment. They can't submit the review, or accept or reject comments.

In the UI, the **Reviewers** panel shows each agent's verdict, comment counts and summary. Its comments appear inline as they arrive:

- **Accept** or **Reject** each comment, or use **Accept all pending** / **Reject all** for one reviewer. **Undo** sets a comment back to pending.
- When you submit (you are the final approval), your comments and every agent comment you haven't rejected (accepted or still pending) go to the implementing agent, labelled with their author. Rejected comments and dropped summaries are kept only in `.git/ai-review/history/`.

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
| `agents.json` | agent reviewers' comments and your accept/reject decisions |
| `session.json` | port and token of the running review, so `agent.js` can find it (exists only while a review is running) |

Environment variables: `AI_REVIEW_NO_OPEN=1` stops the browser from opening; `AI_REVIEW_HOOK_TIMEOUT=<min>` sets how long the hook waits.

## Development

```bash
npm test
```
