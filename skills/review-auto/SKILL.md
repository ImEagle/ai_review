---
name: review-auto
description: Turn automatic code review on or off for this repository. When on, the review UI opens every time Claude finishes a turn with new uncommitted changes, and the review is fed back automatically. Use when the user asks to enable/disable/check automatic or per-turn review.
argument-hint: "on | off | status"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/auto.js" $ARGUMENTS
```

Report the resulting state to the user in one line. If it was turned **on**, add:
"From now on, whenever I finish with new uncommitted changes, the review UI opens and I wait for your review. Approve lets me stop; Comment or Request changes sends your feedback back to me. Changes that already exist now count as reviewed."
