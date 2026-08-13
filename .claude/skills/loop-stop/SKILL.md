---
name: loop-stop
description: Stops the autonomous improvement loop and reports what was still in flight when it stopped. Use when asked to halt a running loop, or before switching branches while one is running.
allowed-tools: Bash, Read
---

# Stopping the loop

Current state:

!`npm run loop-status`

## Stopping

```bash
npm run stop
```

This writes a stop file. The loop notices it on its next poll, so it exits within
`POLL_INTERVAL` seconds — 30 by default. The command also terminates every live task
process tree immediately and reports each task and PID. If a process tree cannot be
terminated, the command reports the failure and exits non-zero.

## What stopping retains

Task specifications, logs, status files, worktrees, and branches are retained for
recovery. No terminated agent continues working after `stop` returns.

For a task that completed before the stop, inspect its log and merge it by hand:

```bash
npm run logs -- <task-id>
npm run merge -- <task-id> --yes
```

For a task that was terminated while running, inspect its log and worktree before doing
anything destructive. It has no automatic retry. Preserve any useful changes manually,
then clean up and re-enqueue the retained specification:

```bash
npm run logs -- <task-id>
npm run cleanup -- <task-id>
npm run enqueue -- <task-id>
```

`cleanup` removes the worktree and its branch. Look at the log first — a task that
produced useful uncommitted or unmerged work loses it here.

## Report

Say that the loop is stopping, list the task process trees it terminated, and identify
the retained worktrees that need recovery or cleanup.
