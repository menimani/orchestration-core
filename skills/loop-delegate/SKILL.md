---
name: loop-delegate
description: Turns a decision from the conversation into a queued orchestration task, safe to do while the loop runs. Use when asked to hand work to Codex, queue an improvement for the loop, or capture something just decided as the next loop target.
argument-hint: "[what was decided]"
allowed-tools: Bash, Read
---

# Delegating a decision to the loop

Current state:

!`{{ORCHESTRATION_COMMAND_PREFIX}} loop-status`

## What qualifies

Delegate decisions, not open questions. The task must be able to run unattended:
it depends on no other task's output, it can be specified so that no judgement
call is left to the implementer, and it is larger than the cost of writing that
specification. Anything still being discussed gets settled in the conversation
first; anything smaller than its own specification is faster done directly.

## Writing the description

The description becomes the task's requirement verbatim, so carry the decision
over from the conversation completely — the implementer has none of its context:

- Name the files and directories the change touches.
- State the requirement so nothing is left to interpretation. Where the
  conversation weighed options and picked one, state the pick, not the debate.
- Give a completion condition that can be run: a test name, a command.

## Delegating

```bash
{{ORCHESTRATION_COMMAND_PREFIX}} delegate -- "<description>"
```

The description may span multiple lines inside one quoted argument. Add
`--effort high` when the work needs deep reasoning; without it the task runs at
the loop's standard effort (`TASK_EFFORT`, default medium).

Delegating the same description twice is safe — the description index maps it
back to the one existing task. Ids follow `YYYYMMDD_HHMMSS_nnn_user-<slug>`.

## What happens next

- **Loop running** — the task starts within one poll (`POLL_INTERVAL`, default
  30s), ahead of any future scan, and is merged automatically. If the loop was
  waiting at a cycle gate, the gate pushes again and re-checks CI after the
  merge.
- **Loop not running** — the task waits in the backlog until `/loop-start`, or
  `{{ORCHESTRATION_COMMAND_PREFIX}} start -- <task-id>` runs it on its own.

## Report

State the task id and the specification path, whether the loop will pick it up
or the backlog is holding it, and how to follow it:
`{{ORCHESTRATION_COMMAND_PREFIX}} logs -- <task-id> -f`.
