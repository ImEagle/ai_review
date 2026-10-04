---
name: review-auto
description: Enable, disable, or check per-turn interactive code review for this repository when the user requests automatic review. In Codex, the active agent runs the check before finishing work; this does not install a runtime hook.
---

Resolve the ai-review installation root from this skill's location (two directories above `skills/review-auto/SKILL.md`, resolving symlinks). Run commands from the repository being reviewed. Use Codex's command-execution tool with the resolved absolute path and the requested action; default to `status`:

```bash
node "<ai-review-root>/server/auto.js" <on|off|status>
```

Report the resulting state. When enabled, explain that Codex will check before finishing work while these instructions remain active in this conversation. Existing changes count as reviewed. The repository flag persists, but this skill does not install a Codex lifecycle hook or guarantee that other conversations load these instructions. The bundled `hooks/hooks.json` registration is for Claude Code.

## Before finishing work while enabled

Run the existing hook as an ordinary command, not as a Codex hook registration:

```bash
AI_REVIEW_NO_OPEN=1 node "<ai-review-root>/server/stop-hook.js" </dev/null
```

This checks the repository flag and diff hash. It exits silently if disabled or if no new unreviewed changes exist. Otherwise it prints a localhost review URL to stderr and waits up to 55 minutes (configurable with `AI_REVIEW_HOOK_TIMEOUT`).

Use a short initial command yield and retain the returned session ID. Share the URL in commentary and collect command output with empty-input session reads, waiting at most 60 seconds per call and providing brief updates. Keep the turn active; do not assume Codex will notify you after ending it. Do not edit files while review is pending. If the user asks to stop, stop waiting.

On completion, a submitted Comment or Request changes with feedback produces JSON with `decision: "block"` and review Markdown in `reason`. This is the script's feedback format, not an execution-approval rejection. Address every comment using the same rules as [the review skill](../review/SKILL.md), then run the check again before finishing. The script remembers the reviewed diff, so unchanged changes do not reopen the UI. Approval, cancellation, timeout, or an empty review exits without feedback; do not interpret cancellation or timeout as approval.

Report execution failures rather than claiming review completed. Respect command approvals and treat feedback as scoped to the reviewed changes.
