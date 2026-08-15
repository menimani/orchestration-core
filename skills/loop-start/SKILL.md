---
name: loop-start
description: Starts the autonomous improvement loop in the background, after checking nothing is already running. Use when asked to begin a scan-and-fix run, or to resume one that was stopped.
argument-hint: "[MAX_SCAN_CYCLES=n] [MAX_PARALLEL=n]"
allowed-tools: Bash, Read
---

# Starting the loop

Current state:

!`{{ORCHESTRATION_COMMAND_PREFIX}} loop-status`

## Before starting

A second loop against the same repository will fight the first over the queue and the
worktrees. If `orchestration/queue/loop.pid` names a live process, stop rather than start.

The loop commits and merges on its own, so start it on a topic branch, never on `main`.

## Starting

```bash
{{ORCHESTRATION_COMMAND_PREFIX}} loop -- --daemon
```

`--daemon` is what puts it in the background; without it the loop holds the terminal.
Settings go in front of the command:

| Variable | Default | Effect |
|----------|---------|--------|
| `MAX_SCAN_CYCLES` | 3 | How many scan-and-fix rounds before it promotes the PR and exits |
| `MAX_PARALLEL` | 3 | Codex processes at once |
| `MAX_EMPTY_SCANS` | 2 | Scans finding nothing before it stops early |
| `REVIEW_ENABLED` | true | Wait for a review flag between cycles instead of continuing |
| `AUTO_REVIEW` | false | Review each cycle's diff automatically; findings become fix tasks |
| `MAX_REVIEW_ROUNDS` | 2 | Review rounds per cycle before resuming with findings outstanding |
| `REVIEW_EVERY_N_CYCLES` | 1 | Review every Nth cycle (the final cycle is always reviewed) |
| `MAX_FINAL_REVIEW_ROUNDS` | 4 | Final-cycle rounds before the loop stops instead of promoting unresolved findings |
| `MAX_BURST_FAILURES` | 3 | Task failures in one poll before the loop stops and blames the environment |
| `INTEGRATION_BRANCH` | empty | Separate task/merge/PR branch; when set, the daemon checkout stays fixed for the run |
| `ISSUE_QUEUE_ENABLED` | false | Findings become claimable forge issues instead of local queue entries (each concurrent worker requires a distinct forge account) |
| `ISSUE_LEASE_HOURS` | 3 | Hours a claimed issue may sit untouched before its lease is reaped back to ready |
| `CI_GATE_ENABLED` | false | Whether the gate waits for CI — a draft PR has no checks, so waiting would hang |
| `MAX_CONSECUTIVE_MERGE_FAILURES` | 3 | Merges failing in a row before it stops — the task finished, its verification did not |
| `SCAN_ENABLED` | true | Set false to work the existing queue without scanning |
| `SCAN_PARALLEL` | 2 | Scans per cycle, splitting the checklist between them (1 = single full scan, up to 4) |
| `SCAN_EFFORT` | high | Codex reasoning effort for scan tasks |
| `TASK_EFFORT` | medium | Codex reasoning effort for queued tasks (`delegate --effort` overrides per task) |
| `REVIEW_EFFORT` | high | Codex reasoning effort for automatic review tasks |
| `TASK_GATE` | full | `light` runs compile/lint per task and the full suites once at each cycle gate — faster, but a suite break names no task |

## While it runs

Work can be handed to a running loop without stopping it — `/loop-delegate`
turns a decision from the conversation into a queued task the loop picks up on
its next poll, ahead of any future scan.

The daemon holds the code it started with. **Editing the loop source under
`{{ORCHESTRATION_PACKAGE_PATH_PREFIX}}src` changes
nothing until the loop is restarted**, and reporting that a fix took effect without
restarting is how a fix gets credited that never ran.

Follow it with `{{ORCHESTRATION_COMMAND_PREFIX}} queue`, or read
`orchestration/logs/loop.log`. Per-task output is in `orchestration/logs/<task-id>.log`,
and merge output — including the tests run before each merge — in `<task-id>.merge.log`.

## When it finishes

It prints `LOOP_DONE: <PR URL>` and exits. The PR body it leaves behind is built from the
commit log, so a change reworked across cycles appears as every intermediate step,
including ones later reverted. **Rewrite the body from the diff before anyone reviews
it** — `/git-pr` describes the format.
