---
name: verify-changes
description: Runs every check the repository has, choosing them from what the working tree touched, and reports each result. Use before committing, or when asked to verify the tree.
allowed-tools: Bash, Read
---

# Verifying changes

Changed paths:

!`git status --short`

## Choose by what changed

| Touched | Run | From |
|---------|-----|------|
| Any source or documentation | `node checks/english-only.ts` | repository root |
| `src/`, `tests/`, `checks/`, `orchestration/` | `npm run typecheck`, `npm test` | repository root |
| `templates/`, `orchestration/templates/` | `npm test` | repository root |
| `SPEC.md` | `npm test` | repository root |
| `.github/workflows/` | nothing local — the run itself is the check | — |

There is no build step: the core runs as TypeScript, so the language check, type checker,
and suite are its gates. `SPEC.md` is pinned by tests, so editing it without running them
leaves the description and the behaviour disagreeing.

Run the checks that apply, not all of them: a README change does not need the suite.

## Reading the results

Measure the exit code directly. `command | tail` reports the exit code of `tail`, so a
failing check reads as a pass — redirect to a file and check `$?` instead.

The suite drives real git repositories in temporary directories. Parallel workers made
their fixtures race, so CI runs it single-threaded:

```
npm test -- --pool=threads --poolOptions.threads.singleThread
```

Use that form when a failure will not reproduce, before concluding it is a flake.

A running loop keeps repository checkouts under `orchestration/worktrees/`. Those hold
their own copies of this suite; `vitest.config.ts` excludes them so a live loop does not
turn into thousands of extra tests. Do not run builds or installs while a loop is
running — they lock files the loop's own workers need.

## Report

State each check and its result, then whether the tree is safe to commit. A check that
was skipped is reported as skipped, with the reason — never folded into a pass.
