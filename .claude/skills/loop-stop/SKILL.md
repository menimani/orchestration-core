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
`POLL_INTERVAL` seconds — 30 by default — not immediately.

## What stopping does not do

**Running Codex processes are not killed.** They carry on in their worktrees, finish, and
sit there with nobody to merge them. Anything reported as `running` above is in that
position once the loop is gone.

For each one, either wait for it and merge by hand:

```bash
npm run logs -- <task-id>
npm run merge -- <task-id> --yes
```

or abandon it:

```bash
npm run cleanup -- <task-id>
```

`cleanup` removes the worktree and its branch. Look at the log first — a task that
finished its work but had not been merged yet loses it here.

## Report

Say that the loop is stopping, then list what was running and what has been left in a
worktree. A task left unmerged and unmentioned is work that quietly disappears.
