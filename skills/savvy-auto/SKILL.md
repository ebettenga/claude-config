---
name: savvy-auto
description: Start the savvy-flow orchestrated delivery flow by yourself for substantial implementation work, so the user doesn't have to remember /savvy-flow. Use when the user asks for a change that spans several files or steps and would take a long session alone: a new feature across components, a multi-file refactor or migration, a bug that needs investigation and then a fix, or a batch of independent fixes. Do not use for questions, explanations, reviews, one-file or few-line edits, config tweaks, running a command, or anything a handful of tool calls settles.
---

# Start savvy-flow on your own

savvy-flow (from the claude-kit plugin) only starts when the user types `/savvy-flow`. This skill starts it for them, so they don't have to remember.

## 1. Decide whether it fits

Use it only when all of these hold:

- The task is implementation: code changes the user asked for, not a question or a review.
- It is big enough to split: about three or more independent pieces of work, or one hard piece plus verification.
- Doing it alone would take a long session.

Otherwise, do the task directly. When unsure, do it directly: savvy-flow spends more of the user's usage than one session would.

## 2. Say so, then go

Tell the user in one line before starting, so they can stop it:

> Using savvy-flow for this: I'll plan it, hand pieces to worker agents, and review what they return.

Don't wait for a reply unless the plan (next step) has a real question in it.

## 3. Load savvy-flow's own instructions

Find the installed skill file (the plugin version changes, so take the newest):

```bash
ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/claude-kit/savvy-flow/*/skills/savvy-flow/SKILL.md | sort -V | tail -1
```

Read that file in full with the Read tool and follow it exactly as if the user had run `/savvy-flow <their request>`: you are the orchestrator, and the task is the user's request as they gave it.

If the command finds nothing, savvy-flow isn't installed in this setup. Say so in one line and do the task directly.

## Notes

- The worker agents ship with the plugin; the Agent tool lists them as `savvy-flow:savvy-light` and so on. If they aren't listed, savvy-flow's own preconditions tell you to stop and say so.
- If the user says not to use savvy-flow, don't use it again in this session.
