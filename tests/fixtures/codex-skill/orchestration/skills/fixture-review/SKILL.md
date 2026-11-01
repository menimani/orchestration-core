---
name: fixture-review
description: Reviews a fixture change. Use when exercising the Codex rendering.
argument-hint: "<pr-number>"
disable-model-invocation: true
allowed-tools: Bash(gh pr view:*), Read
---

# Fixture review

Pull request:

!`gh pr view $ARGUMENTS --json title,body`

  !`git diff --stat`

Read `CLAUDE.md`, then `.claude/skills/fixture-review/references/checklist.md`.
Leave `.claude/skills/fixture-missing/SKILL.md` as it is.

Run `/fixture-review` again after fixes, `/verify-changes` before committing,
/git-review for a second opinion, and `/fixture-other` otherwise. Paths such as
src/fixture-file stay untouched.

Check progress with {{ORCHESTRATION_COMMAND_PREFIX}} loop-status and read
`{{ORCHESTRATION_PACKAGE_PATH_PREFIX}}skills/manifest.json`.
