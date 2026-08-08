# Orchestration TypeScript rewrite — behavior specification

This is the completion checklist for the big-bang rewrite decided on 2026-08-08. The
rewrite ships as a single cutover: `orchestrate.sh` becomes a thin wrapper invoking
`node orchestration/ts/src/cli.ts`, and the old `bin/*.sh` implementation is deleted only
after one full TS-driven run completes and ships cleanly. Until then it stays in-tree,
uncalled.

Every numbered item below is a behavior the bash implementation learned the hard way
(sources: `orchestration/CLAUDE.md`, `docs/orchestration/*.html`, `bin/*.sh`). The
rewrite is "built" when every item is implemented and covered by a vitest test ported
from or equivalent to `orchestration/tests/*.sh`.

## Runtime

- TypeScript executed natively by Node >= 23.6 (type stripping): no build step, no
  `enum`/`namespace`/parameter properties or other non-erasable syntax.
- `tsc --noEmit` joins the repository checks; vitest runs the test suite.
- No `jq` dependency anywhere (this deletes the Windows-jq-CRLF bug class; the invariant
  it protected — values read from status files compare clean — still holds and is tested).
- The command surface is the `scripts` block of `orchestration/ts/package.json` —
  `orchestrate.sh` is not kept (decided 2026-08-08; supersedes the frozen-wrapper plan).
  Each current command maps to a script of the same name (`npm run -C orchestration/ts
  loop`, `... delegate -- "<description>"`, `... loop-status`, `queue`, `stop`, `start`,
  `status`, `logs`, `merge`, `cleanup`, `prune`, `new`, `enqueue`), all dispatching into
  `src/cli.ts`. The skills (`loop-start`, `loop-stop`, `loop-delegate`) are updated to
  the npm form as part of the cutover. What stays frozen: the environment variable
  names (they pass through npm unchanged, so launch commands keep their shape) and the
  output lines the skills and tests key on (`Enqueued:`, `Created:`, `CYCLE_COMPLETE:`,
  `LOOP_DONE:`, `FAILED:`, `[loop]` prefixes).

## Task lifecycle

1. A task is `running` while its runner process is alive, `completed` once
   `TASK_COMPLETE` appears on its own line in the task's `.final` file (written by the
   runner through its last-message output), and `failed` when the process is gone without
   that marker. Markers in the transcript log are ignored — only the final-message file
   is authoritative.
2. Task ids are `YYYYMMDD_HHMMSS_nnn_<slug>` with `nnn` a per-day sequence; slugs end in
   `scan` for scans and start with `ci-fix`, `auto-`, or `user-` for CI fixes, scan
   findings, and delegated work. Listings sort chronologically.
3. `queue/desc-index` maps a description to its task id: the same finding reported twice
   or the same decision delegated twice resolves to the one existing task.
4. Each task runs in its own worktree under `orchestration/worktrees/<id>` on branch
   `task/<id>`.
5. Failure handling: print `FAILED: <id>` with the log path, record the loss against the
   current cycle (`queue/failed-<cycle>`, once per task), never retry automatically.
   `cleanup` clears the announce markers so a manual retry is watched, not silent.

## Growth and decisions

6. A completed task's final message is scanned for `NEXT_TASK: <description>` lines;
   each becomes a queued task. `MAX_GROWTH_DEPTH` (default 2) and `MAX_TOTAL_TASKS`
   (default 50) bound the growth. Directives elsewhere in the transcript are ignored.
7. `DECISION_REQUIRED: <text>` is logged and carried into the PR risks, never queued.
   Dedup: a line naming a `GHSA-`/`CVE-` identifier matches on the identifier (a scan
   words the same advisory differently every cycle); a line naming neither matches on
   the whole line.

## Merging

8. A merge aborts and keeps the worktree when the worktree holds uncommitted changes or
   no new commits — an agent that forgot to commit must not silently lose its work.
   Scan tasks and `--inspect` tasks are exempt (investigation produces no commits).
9. Pre-merge tests are chosen from the paths the worktree touched. `TASK_GATE=full`
   runs the full suites per merge; `TASK_GATE=light` runs compile/lint per merge and the
   full suites once at each cycle-gate entry. Light-gate attribution cost (a suite break
   at the gate names no task) is accepted and documented; the gate stops the loop rather
   than promote a failing tip.
10. `MAX_CONSECUTIVE_MERGE_FAILURES` (default 3) merge failures in a row stop the loop;
    any successful merge resets the count. When the merge log names Docker or an
    unreachable registry, say which — "tests failed" misattributes an environment
    failure to the task's diff.
11. A task that merges while a cycle gate is already waiting clears that cycle's
    complete flag, so the gate pushes and verifies again with the new commits included.

## Scans and cycles

12. Scans start on idle (nothing queued or running), `SCAN_PARALLEL` (1-4) at a time
    over disjoint groups of the checklist's sections. A cycle counts as empty only when
    every scan in it found nothing; `MAX_EMPTY_SCANS` consecutive empty cycles end the
    run early. Scan yield is recorded per cycle (`queue/scan-yield-<n>`) and folded into
    the empty counter once, at the gate.
13. `cycle_is_final` is true when the cycle number reaches `MAX_SCAN_CYCLES`, or when
    the cycle's scans all came back empty and one more empty cycle reaches
    `MAX_EMPTY_SCANS`. The current cycle number lives in `queue/scan-count.txt` and is
    re-read every poll (this is also the documented lever for forcing an early final
    cycle on a running loop).
14. Effort defaults: scans run the runner at high reasoning effort, queued tasks at
    medium; `SCAN_EFFORT`, `TASK_EFFORT`, `SCAN_MODEL`, `TASK_MODEL` override, and
    `delegate --effort` overrides per task.

## The cycle gate

15. The gate runs only when nothing is queued or running. Sequence: report lost tasks
    (loss note into `queue/decisions.txt`, deduped), run the cycle suite, ensure/update
    the draft PR, print `CYCLE_COMPLETE: <n>/<max>` with the PR URL, then the CI gate,
    then review.
16. The CI gate is skipped by default (`CI_GATE_ENABLED=false`): CI does not run on
    draft PRs, and a gate polling for absent checks hangs forever. When enabled:
    pending → keep polling; failure → generate a ci-fix task, up to
    `MAX_CI_FIX_ATTEMPTS`, then stop rather than poll a gate that cannot pass.
17. Review: `AUTO_REVIEW=true` dispatches a review task reading the whole branch diff;
    findings come back as `NEXT_TASK` lines that become fix tasks and clear the cycle
    flag (the gate re-verifies before the next round reads the corrected diff). A clean
    round resumes the cycle; `MAX_REVIEW_ROUNDS` bounds rounds per cycle.
    `REVIEW_EVERY_N_CYCLES` skips review on off-cycles (the next reviewed cycle still
    reads their work). The final cycle is always reviewed, and its rounds continue until
    one is clean, bounded by `MAX_FINAL_REVIEW_ROUNDS`; exceeding that stops the loop
    for a person instead of promoting a branch its own review keeps rejecting.
    Review tasks commit nothing and are exempt from the merge commit check.
18. After the final cycle passes the same gate, the PR is promoted from draft,
    `LOOP_DONE: <PR URL>` is printed, session state is cleaned up, and the loop exits.

## Failure containment

19. `MAX_BURST_FAILURES` (default 3) task failures observed in one poll stop the loop —
    the cause is the environment (network, credentials, runner CLI), and every task
    started meanwhile burns tokens reaching the same wall. Work that never ran leaves no
    diff, so nothing downstream can notice it is missing; the loop must.
20. Failures are announced once per task (a `.failed` flag file), recorded against the
    cycle, and carried into the PR risks.

## The generated pull request

21. The title reports `cycle <n>/<max>` while running and category counts when finished.
    The body is rebuilt each cycle from commit classification into fixed sections
    (Features, Bug Fixes, Security, Project Operations, Risks), `- None` where empty.
    Title and body come from the same classification, so they cannot disagree.
22. An HTML comment on the first body line marks the text as generated; a hand-edited
    body (marker gone) is never overwritten again.
23. The body is built from commit history and therefore shows intermediate steps of
    reworked changes; `LOOP_DONE` output reminds that the summary is rewritten by hand
    from the diff before review.

## Process control

24. A PID lock (`queue/loop.pid`) keeps the loop single-instance per repository; a stale
    stop file is cleared on startup, after the PID lock is taken (never before — it may
    be another instance's signal).
25. The stop file (`queue/stop`) is checked at the top of every poll; stopping does not
    kill running runner processes — they finish in their worktrees with nobody left to
    merge them, and `loop-status` says so.
26. The daemon holds the code it started with; the wrapper prints where the log lives
    and how to stop.
27. `prune --days N` deletes logs/status/generated specs/queue markers of tasks finished
    more than N days ago; it never touches an unmerged or failed task, a worktree still
    on disk, or a spec tracked by git. `--dry-run` lists without deleting.

## Delegation surface

28. `delegate "<description>" [--effort e] [--inspect]` writes a task spec from the
    description (multi-line allowed), appends the shared testing requirements, and
    enqueues it; queued work always runs ahead of the next scan. `--inspect` marks
    report-only work whose merge is not rejected for producing no commits; its
    `NEXT_TASK` findings reach the queue either way.

## Adapter seams (new in the rewrite)

29. All forge access goes through `adapters/forge.ts` (`FORGE=github` selects
    `forge-github.ts`; gitea/gitlab implementations can be added without touching the
    core). The interface returns normalized values only: PR state plus `name:conclusion`
    check lines; draft-vs-ready is a forge-neutral flag. Planned issue-queue operations
    (create/list-ready/claim/close, fingerprint dedup, files-touched metadata,
    stale-lease reaping) belong to this interface but ship after the parity cutover.
30. The runner is invoked only through `adapters/runner.ts` (`RUNNER=codex` selects
    `runner-codex.ts`). The runner contract is the output markers — `TASK_COMPLETE`,
    `NEXT_TASK:`, `DECISION_REQUIRED:` in the final-message file — plus effort/model
    arguments mapped to CLI flags inside the adapter. Any runner honoring the contract
    is substitutable.
31. Everything the orchestration knows about the repository it runs in — which commands
    verify a merge, which paths make each check relevant, which suites prove a cycle's
    tip, and which toolchain breakage a reinstall repairs — lives in the project
    adapter (`adapters/project.ts`, `PROJECT=shiora` selects `project-shiora.ts`). The
    core executes the declarations and owns the generic behavior: output capture,
    failure attribution, and stop decisions. Porting the orchestration to another
    repository means writing a project adapter and nothing else.

## Test parity

Each bash test file maps to a vitest suite: `test-lib` → id/slug/status helpers,
`test-loop-gate` → gate state machine (cycle flags, CI outcomes, review rounds, final
promotion, stop conditions), `test-loop-branch-state` → run-branch bookkeeping,
`test-pr-body` → commit classification and section building, `test-task-delegate` /
`test-task-enqueue` / `test-task-status` / `test-task-prune` / `test-checks` → their
namesakes. The gate suite is the load-bearing one; port it first and keep its cases
1:1 so the state machine is proven equivalent before anything else moves.
