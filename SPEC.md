# Orchestration TypeScript rewrite — behavior specification

This is the completion checklist for the big-bang rewrite decided on 2026-08-08. The
cutover is complete: the TS-driven validation run (run 9) completed and shipped on
2026-08-08, and the bash implementation was deleted. Every numbered behavior below now
lives only here and in the vitest suite that pins it.

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
- Core subtree updates default on. The daemon logs whether `CORE_AUTO_UPDATE` is on or
  off at startup; `false` skips the pre-cycle check entirely. `UPSTREAM_REMOTE` defaults
  to the package's `upstreamRepo` value used by `report-upstream`, and
  `UPSTREAM_BRANCH` defaults to `main`.
- The command surface is the `scripts` block of the package's `package.json` (the
  repository-root manifest here, or `orchestration/ts/package.json` when installed as a
  subtree) — `orchestrate.sh` is not kept (decided 2026-08-08; supersedes the
  frozen-wrapper plan). Runtime commands map to same-name entries in the command registry
  in `src/cli.ts`; those two files are the authoritative command list. The skills
  (`loop-start`, `loop-stop`, `loop-delegate`) are updated to
  the npm form as part of the cutover. A background launch prints status and stop
  commands for the package's actual location: direct `npm run` commands at the repository
  root, or `npm run -C <package-path>` when installed as a subtree. What stays frozen:
  the environment variable names (they pass through npm unchanged, so launch commands
  keep their shape) and the
  output lines the skills and tests key on (`Enqueued:`, `Created:`, `CYCLE_COMPLETE:`,
  `LOOP_DONE:`, and `FAILED:`). Loop daemon events in `loop.log` use
  `YYYY-MM-DD HH:mm:ss [loop <cycle>/<cap>] <event> <subject> <detail>`: cycle and cap
  are zero-padded, event names occupy a ten-character column, and subjects shorter than
  twelve characters are padded so details align. Every physical line receives the full
  prefix and messages are capped at 80 characters after it. The three machine markers
  are the exception to presentation-only output: a foreground loop also prints each
  marker as an exact standalone line, while a background loop writes that exact line to
  `logs/loop-markers.log`. Their copies in `loop.log` still receive the timestamp and
  cycle prefix, and retain the marker name rather than being rewritten as display events.

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
5. Failure handling: emit `FAILED: <id>` with the log path to the machine-marker sink,
   with a separately formatted copy in `loop.log`; record the loss against the
   current cycle (`queue/failed-<cycle>`, once per task), never retry automatically.
   `cleanup` clears the announce markers so a manual retry is watched, not silent, but
   only after verifying that the task process stopped, the worktree directory and Git
   registration were removed, and the task branch was deleted; a failed cleanup returns
   non-zero and retains the task state for a safe retry.

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
   asks the project adapter for its full merge checks; `TASK_GATE=light` asks it for
   reduced merge checks, then runs the adapter's cycle suite once at each cycle-gate
   entry. Light-gate attribution cost (a suite break at the gate names no task) is
   accepted and documented; the gate stops the loop rather than promote a failing tip.
10. `MAX_CONSECUTIVE_MERGE_FAILURES` (default 3) merge failures in a row stop the loop;
    a completed task remains eligible for merge on later polls, and any successful merge
    resets the count. Re-claiming completed-but-unmerged work requests that merge instead
    of silently treating the task as already processed. When the project adapter classifies
    an infrastructure failure, or the merge log names an unreachable registry, say which —
    "tests failed" misattributes an environment failure to the task's diff.
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
14a. Immediately before a new cycle consumes its number or starts a scan, after the
    previous cycle gate has closed and while no task is running, the daemon fetches the
    configured core upstream and compares its tip with the last `git-subtree-split` for
    this package's prefix. If it is behind, the daemon runs `git subtree pull --squash`.
    A package-file change logs aligned `Updated    core        <old8>..<new8>` and
    `Restarting core        for cycle <n>` events, releases daemon ownership, and starts
    the same command with the same environment, working tree, and run branch. A daemon
    otherwise runs the code it started with. The check never runs mid-cycle. A dirty
    working tree or a pull conflict logs `WARN`, aborts any in-progress merge, and lets
    the cycle proceed unchanged so local divergence is resolved by the consumer.

## The cycle gate

15. The gate runs only when nothing is queued or running. Sequence: report lost tasks
    (loss note into `queue/decisions.txt`, deduped), run the cycle suite, ensure/update
    the draft PR, emit `CYCLE_COMPLETE: <n>/<max>` with the PR URL to the machine-marker
    sink and a formatted copy to `loop.log`, then the CI gate,
    then review. Remote work defers the gate with a `Waiting remote` event when its
    pending issue set changes and every ten minutes while unchanged. A light-gate cycle
    suite logs its `Started Suite` event before invoking the blocking commands.
16. The CI gate is skipped by default (`CI_GATE_ENABLED=false`): CI does not run on
    draft PRs, and a gate polling for absent checks hangs forever. When enabled:
    pending → keep polling; failure → generate a ci-fix task, up to
    `MAX_CI_FIX_ATTEMPTS`, then stop rather than poll a gate that cannot pass. A PR with
    zero checks remains unknown regardless of its age unless the project adapter
    explicitly sets `ciChecksExpected: false`.
17. Review: `AUTO_REVIEW=true` dispatches a review task reading the whole branch diff;
    findings come back as `NEXT_TASK` lines that become fix tasks and clear the cycle
    flag (the gate re-verifies before the next round reads the corrected diff). A clean
    round resumes the cycle; `MAX_REVIEW_ROUNDS` bounds rounds per cycle.
    `REVIEW_EVERY_N_CYCLES` skips review on off-cycles (the next reviewed cycle still
    reads their work). When automatic review is enabled, the final cycle is always
    reviewed, and its rounds continue until one is clean, bounded by
    `MAX_FINAL_REVIEW_ROUNDS`; exceeding that stops the loop
    for a person instead of promoting a branch its own review keeps rejecting.
    Review tasks commit nothing and are exempt from the merge commit check.
18. After the final cycle passes the same gate, the PR is promoted from draft,
    `LOOP_DONE: <PR URL>` is emitted to the machine-marker sink and as a formatted
    `loop.log` copy, session state is cleaned up, and the loop exits.

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
    tip, which toolchain breakage a reinstall repairs, and how commits and changed paths
    become pull-request sections, area labels, and risk bullets — lives in the project
    adapter (`adapters/project.ts`; with neither selection variable set, the single
    `../project/project-*.ts` file is discovered; `PROJECT=<name>` selects
    `../project/project-<name>.ts`; `PROJECT_ADAPTER` overrides the path). The
    core executes the declarations and owns the generic behavior: Git history and diff
    collection, pull-request formatting, output capture, failure attribution, and stop
    decisions. Porting the orchestration to another repository means writing a project
    adapter and nothing else.

## The issue queue (new in the rewrite, opt-in)

### Trust model

The loop trusts its installed orchestration code, its operator-supplied configuration and
templates, and forge actors whom the adapter identifies as having repository write access.
Write access is the authorship boundary because repository administrators have already
authorized those accounts to change the code the loop will eventually merge. Public issue
bodies, comments, repository files, diffs, and commit messages are otherwise untrusted;
being visible in the repository or carrying a loop-shaped marker does not grant authority.
For GitHub, the adapter maps `OWNER`, `MEMBER`, and `COLLABORATOR` author associations to
that forge-neutral write-access verdict and treats every other or unknown association as
untrusted.

Authorship is checked when a ready issue is claimed, not while findings are listed. An
untrusted issue remains unassigned and ready, receives `loop:untrusted-author`, and emits
a warning naming its author so a maintainer can inspect it and re-file genuine work. A
task materialized from a trusted issue still frames the body as delimited untrusted data:
prompt-like instructions in the requested change are reported and refused, not executed.
Scan and review prompts apply the same rule to repository-controlled text they inspect or
quote. A `MERGED:` comment affects stale-lease reaping or idle detection only when its
author has write access; idle detection additionally retains the merge-SHA ancestry check,
so authorship and verified ancestry must both hold.

32. With `ISSUE_QUEUE_ENABLED=true`, scan and review findings become forge issues
    (labels `loop:finding` + `loop:ready`) instead of local queue entries, under the
    same growth bounds. A finding is filed in the repository the loop is running
    against, never anywhere else. An issue is filed once per fingerprint: the advisory
    identifier when one is named, else the finding's tag plus the first path it
    names and a digest of normalized finding terms, else that normalized digest alone.
    Normalization ignores case, punctuation, whitespace, word order, grammatical filler,
    plural and selected action-word forms, and issue/commit references; distinct terms
    still distinguish separate requirements in one file. Review findings are checked
    independently before unresolved findings are combined; a combined issue stores every
    constituent fingerprint, so it also suppresses a later individual report while
    that work remains pending. Once a non-advisory issue's task merges into the run
    branch, a later scan or review observed the post-fix tree and the same fingerprint
    becomes fresh work; advisory identifiers remain durable deduplication keys across
    merges because the same advisory recurs with different prose. Pre-granularity open
    issue bodies are interpreted from their requirement text, and their coarse local
    ledger entry is replaced when encountered, avoiding a one-time duplicate round.
33. Worker daemons claim a ready issue by self-assignment. The forge login is the worker
    identity, and every daemon that may claim concurrently must authenticate as a
    distinct forge account. Under that invariant, a simultaneous claim is settled
    deterministically — the lexicographically first login wins, losers unassign
    themselves — and the winner relabels to `loop:in-progress` and materializes the
    issue as a local task through the standard template (completion marker included),
    honoring an `Effort:` field. Daemons sharing an account are indistinguishable
    and may both materialize the issue, so that configuration is unsupported. A
    running linked task adds a `Heartbeat: <ISO timestamp>` issue comment at least every
    30 minutes, moving the forge's `updatedAt` lease clock without changing the issue
    body. Heartbeat timestamps are tracked locally under `queue/heartbeat`; one failed
    forge attempt logs one warning and never fails the poll. A locally running mapped
    task is excluded from that poll's reaping even when its heartbeat fails. An in-progress
    issue without heartbeats for `ISSUE_LEASE_HOURS` (default 3) is reaped back to
    ready, unassigned, so lease expiry identifies a worker that is no longer polling
    rather than a long-running task.
34. The merge commit of an issue-born task carries `closes #N`, so the forge closes
    the issue when the promotion PR lands the commit on the default branch. Immediately
    after merging, the worker comments with the merge commit and run branch and states
    that closure happens on promotion; this refreshes `updatedAt` across the ordinary
    merged-but-not-promoted window. If the issue reaches the lease age before promotion,
    stale-lease reaping recognizes its linked locally merged task and repeats the merge
    comment instead of unassigning or relabeling the issue. That refreshes `updatedAt`
    again, keeping the issue claimed until promotion closes it. A forge outage degrades a
    poll to local-only work; it never stops the loop. Labels are ensured at loop startup.
    The daemon lists open `loop:finding` issues once per poll and partitions that snapshot
    locally for adoption, reconciliation, lease reaping, claiming, and cycle-gate idle
    detection. MERGED-marker comment reads are cached by issue number and `updatedAt`.
    Closed lifecycle labels are reconciled at startup and once on cycle-gate entry, not on
    every idle poll. A forge rate-limit response pauses further forge calls until its
    reported reset (querying `rate_limit` when needed), logs one aligned `Waiting forge`
    event, and resumes without attributing even a long wait to the branch.
    The daemon records issue mode in
    `queue/issue-mode` so a separate `delegate` process can publish ready work for the
    daemon to claim and materialize locally, including any effort or inspection setting.
    A new issue is unassigned with
    `loop:finding` + `loop:ready`; a matching open issue is reused without claiming it.
    Delegation remains local-only with a warning only when the forge fails before any remote write;
    once creation may have happened, the issue is reconciled or the command aborts.
    The marker includes the daemon PID, is removed with the PID lock on every graceful
    exit, and is ignored when its owning process is no longer alive.
35. `WORKER_MODE=true` defaults off and requires `ISSUE_QUEUE_ENABLED=true`. A worker-mode
    daemon is execution-only: it never scans, enters a cycle gate, creates or updates a
    pull request, runs a review, or merges. It claims and heartbeats ready issues through
    the standard path and starts their local tasks. A completed task with commits pushes
    `task/<id>` to `origin`, comments the branch and exact head commit on its issue, and
    swaps `loop:in-progress` for `loop:merge-ready`. A completed inspection with no
    commits comments and closes its issue instead. Its poll status uses the shared
    `Status     Running=<n>  Queue=<n>` event; because workers never scan, their loop-log
    prefix carries cycle zero rather than a worker-specific replacement for the cycle.
36. Exactly one normal, non-worker daemon owns the run tree and is the merger. After
    processing local completions, each stop-file-free poll adopts `loop:merge-ready`
    issues from that poll's shared finding snapshot: it reads the reported branch and head, fetches that branch
    from `origin`, verifies the head and that it adds commits to the current branch, runs
    the project adapter's path-selected checks in a detached worktree, and merges with
    `--no-ff` and `closes #N`. It persists a successful adoption before updating the
    issue, so a later poll retries failed metadata updates without merging again. A
    successful adoption logs aligned `Merging` and `Merged` events keyed by the short
    task id, with the latter naming the first eight characters of the merge commit;
    promotion closes the issue. A failure logs the aligned `Failed` event with the short
    task id and merge-log name. It is
    commented on the issue, swaps `loop:merge-ready` for `loop:merge-failed`, and counts
    through the consecutive-merge-failure limit instead of returning work to ready.
    The shared-work label state machine is `loop:ready` → `loop:in-progress` →
    `loop:merge-ready` → closed or `loop:merge-failed`; inspections take the intentional
    `loop:in-progress` → closed shortcut.

## Test parity

Each bash test file maps to a vitest suite: `test-lib` → id/slug/status helpers,
`test-loop-gate` → gate state machine (cycle flags, CI outcomes, review rounds, final
promotion, stop conditions), `test-loop-branch-state` → run-branch bookkeeping,
`test-pr-body` → commit classification and section building, `test-task-delegate` /
`test-task-enqueue` / `test-task-status` / `test-task-prune` / `test-checks` → their
namesakes. The gate suite is the load-bearing one; port it first and keep its cases
1:1 so the state machine is proven equivalent before anything else moves.
