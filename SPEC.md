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
  twelve characters are padded so details align. Events preserve their complete first
  line; multiline traces and command output belong in the referenced task or suite log.
  The three machine markers
  are the exception to presentation-only output: a foreground loop also prints each
  marker as an exact standalone line, while a background loop writes that exact line to
  `logs/loop-markers.log`. The corresponding result is represented separately by an
  aligned display event in `loop.log`.
- `report-upstream` requires one explicit, non-blank description. `--help` prints its
  usage, unknown flag-shaped arguments fail before forge access, and `--dry-run` prints
  the exact title and body without filing. An interactive invocation prints that same
  preview and requires confirmation; a declined confirmation never contacts the forge.

### Retained runtime configuration

`loadConfig` keeps the environment-variable surface from the pre-rewrite launcher.
Missing and empty values use the defaults below. Boolean values accept only the exact
lowercase values `true` and `false`; every other non-empty value is rejected. Numeric
values must be non-negative integers, with the narrower bounds stated below.

| Variable | Default | Contract |
|----------|---------|----------|
| `AUTO_MERGE` | `true` | Merge completed local task worktrees automatically. `false` leaves them completed and eligible for an explicit or later merge. |
| `AUTO_PR` | `true` | Push the run branch, create or update its draft pull request at cycle gates, and promote it with `LOOP_DONE` when the run finishes. `false` performs none of those PR operations. |
| `SCAN_ENABLED` | `true` | Start another scan cycle after the current backlog and gate are clear. `false` drains existing local and shared work, performs any enabled final PR promotion, and exits without starting a scan. |
| `REVIEW_ENABLED` | `true` | Retain the review boundary in the cycle gate. Without `AUTO_REVIEW`, that boundary records resumable state and continues on the next poll; `false` skips it. If `AUTO_PR` is also `false`, disabling this setting bypasses the cycle gate entirely. |
| `REVIEW_EFFORT` | `high` | Reasoning effort for automatic review tasks. Accepted values are `minimal`, `low`, `medium`, and `high`. |
| `MAX_PARALLEL` | `3` | Limit concurrently running queued-task processes and shared-issue claim capacity. It must be at least 1; scan fan-out is controlled separately by `SCAN_PARALLEL`. |
| `POLL_INTERVAL` | `30` | Maximum seconds the daemon waits between polls when no wake signal arrives. Values from 0 through 1800 are accepted; the upper bound keeps polling within the issue-heartbeat interval. |
| `TEST_CMD` | empty | When non-empty, run this command in a task worktree as its merge test and use it instead of the project adapter's path-selected merge checks. A manual merge's `--test-cmd` takes precedence. |
| `SKIP_AUTO_TEST` | `false` | When `true` and no `TEST_CMD` or `--test-cmd` is set, skip the project adapter's automatic merge checks. It does not skip the explicit test command. |

## Task lifecycle

1. A task is `completed` once `TASK_COMPLETE` appears on its own line in the task's
   `.final` file (written by the runner through its last-message output), even if its
   runner process is still alive. Without that marker, it remains `running` while the
   process is alive and becomes `failed` when the process is gone. Markers in the
   transcript log are ignored — only the final-message file is authoritative.
2. Task ids are `YYYYMMDD_HHMMSS_nnn_<slug>` with `nnn` a per-day sequence; slugs end in
   `scan` for scans and start with `ci-fix`, `auto-`, `fix-`, or `user-` for CI fixes,
   scan findings, review-origin fixes, and delegated work. Listings sort chronologically.
3. `queue/desc-index` maps a description to its current task id. The same decision
   delegated twice resolves to one task, as does a repeated finding while its indexed
   task is queued, running, completed, or retryable after failure. If an identical
   non-advisory finding returns after that task has merged, it creates a fresh task and
   updates the index; merged advisories remain deduplicated.
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

6. A completed task's final message is scanned for lines beginning exactly with
   `NEXT_TASK:`. After trimming the description, a line becomes work only when it is
   non-empty, contains none of the pinned format placeholders (literal or HTML-encoded),
   is not pinned no-finding prose, and produces a task slug containing an ASCII letter
   or digit. `MAX_GROWTH_DEPTH` (default 2) and `MAX_TOTAL_TASKS` (default 50) bound the
   growth. Directives elsewhere in the transcript are ignored. The completion remains
   pending, and cannot merge or pass the cycle gate, until accepted findings are
   reconciled and the durable scanned flag is written.
7. `DECISION_REQUIRED: <text>` is logged and carried into the PR risks, never queued.
   Dedup: a line naming a `GHSA-`/`CVE-` identifier matches on the identifier (a scan
   words the same advisory differently every cycle); a line naming neither matches on
   the whole line.

## Merging

8. A merge aborts and keeps the worktree when the worktree holds uncommitted changes or
   no new commits — an agent that forgot to commit must not silently lose its work.
   Scan tasks and `--inspect` tasks are exempt (investigation produces no commits). A
   completed task that still records a runner PID has its process tree stopped and
   verified gone before the merge can discard that PID or remove the worktree.
9. Pre-merge tests are chosen from the paths the worktree touched. `TASK_GATE=full`
   asks the project adapter for its full merge checks; `TASK_GATE=light` asks it for
   reduced merge checks, then runs the adapter's cycle suite once at each cycle-gate
   entry. Light-gate attribution cost (a suite break at the gate names no task) is
   accepted and documented; the gate stops the loop rather than promote a failing tip.
9a. A merge check that passes counts only where its directory satisfies its own declared
    dependencies. A worktree sits inside the checkout it was cut from, so Node resolves
    anything the worktree lacks from the parent's `node_modules`: an install that stopped
    partway produces a pass against a dependency tree nobody assembled, and that verdict
    describes neither tree. Declared dependencies with no `node_modules`, an npm-owned
    directory with no completed-install record, or any declared dependency absent from
    `node_modules` turns the pass into a failure that names what was borrowed. The
    verification follows the check rather than preceding it, because a check may install
    as its own first step.
10. `MAX_CONSECUTIVE_MERGE_FAILURES` (default 3) merge failures in a row stop the loop;
    a completed task remains eligible for merge on later polls, and any successful merge
    resets the count. Re-claiming completed-but-unmerged work requests that merge instead
    of silently treating the task as already processed. When the project adapter classifies
    an infrastructure failure, or the merge log names an unreachable registry, say which —
    "tests failed" misattributes an environment failure to the task's diff.
11. A task that merges while a cycle gate is already waiting clears that cycle's
    complete flag, so the gate pushes and verifies again with the new commits included.
11a. After a local or remote task merge, a first-parent change to this package's
    `package.json` or `package-lock.json` runs `npm ci --no-audit --no-fund` in the
    package root. A successful install records the lockfile hash under `node_modules`.
    At daemon startup, after ownership is acquired and before adapters are loaded, the
    same install runs when that recorded hash does not match or a declared dependency is
    missing. Startup synchronization is limited to the package copy inside the repository
    being orchestrated, so pointing the CLI at another checkout cannot reinstall the copy
    it is running from. Install output is captured; a failure logs a summarized `WARN`
    but does not undo the merge or stop startup. Because failure does not update the
    recorded hash or restore a missing dependency, the next daemon restart retries it.

## Scans and cycles

12. Scans start on idle (nothing queued or running), `SCAN_PARALLEL` (1-4) at a time
    over disjoint groups of the checklist's sections. A cycle counts as empty only when
    every scan in it found nothing; `MAX_EMPTY_SCANS` consecutive empty cycles end the
    run early. The expected scan count (`queue/scan-expected-<n>`) and scan yield
    (`queue/scan-yield-<n>`) are recorded per cycle. Yields are folded into the empty
    counter once, at the gate, only when every expected scan completed successfully.
13. `cycle_is_final` is true when the cycle number reaches `MAX_SCAN_CYCLES`, or when
    the cycle's scans all came back empty and one more empty cycle reaches
    `MAX_EMPTY_SCANS`. The current cycle number lives in `queue/scan-count.txt` and is
    re-read every poll (this is also the documented lever for forcing an early final
    cycle on a running loop).
14. Effort defaults: scans and automatic reviews run the runner at high reasoning
    effort, and queued tasks at medium. `SCAN_EFFORT`, `TASK_EFFORT`, and
    `REVIEW_EFFORT` accept `minimal`, `low`, `medium`, or `high` and override their
    respective defaults; `SCAN_MODEL` and `TASK_MODEL` override the runner model, and
    `delegate --effort` overrides effort per task.
14a. Immediately before a new cycle consumes its number or starts a scan, after the
    previous cycle gate has closed and while no task is running, the daemon fetches the
    configured core upstream and compares its tip with the last `git-subtree-split` for
    this package's prefix. If it is behind, the daemon runs `git subtree pull --squash`.
    A package-file change logs aligned `Updated    core        <old8>..<new8>` and
    `Restarting core        for cycle <n>` events, releases daemon ownership, and starts
    the package's absolute CLI entry point from the package directory, retaining the
    remaining arguments, environment, and run branch. The parent waits for the replacement
    to finish daemon initialization and logs `Restarted`; a failed replacement restores
    ownership, logs `ERROR`, and makes the parent exit nonzero. A daemon otherwise runs the
    code it started with. The check never runs mid-cycle. A dirty
    working tree or a pull conflict logs `WARN`, aborts any in-progress merge, and lets
    the cycle proceed unchanged so local divergence is resolved by the consumer.
    At the same boundary, the package manifest's skills are rendered into every
    directory an agent working in the repository discovers skills in: the selected
    runner's, supplied by its adapter, and `.claude/skills/` for the interactive agent a
    person drives. The Codex adapter renders into repository root `.agents/skills/`; the
    interactive rendering resolves the command prefix only, the canonical sources already
    being in that agent's format. Both use `npm run` as the command prefix in the owning
    repository and `npm run -C <package-path>` in a subtree consumer, and a runner that
    discovers `.claude/skills/` is served once rather than twice. The
    sync replaces only a tree whose content matches its recorded last output; consumer
    divergence is warned and retained, and skills absent from the manifest are untouched.
    A destination that cannot be served is reported without costing the others theirs.
    Shared canonical sources do not live below a runner skill directory, so a subtree
    exposes no nested duplicate of a shared skill.

## The cycle gate

15. The gate runs only when nothing is queued or running. Sequence: report lost tasks
    (loss note into `queue/decisions.txt`, deduped), run the cycle suite, ensure/update
    the draft PR, emit `CYCLE_COMPLETE: <n>/<max>` with the PR URL to the machine-marker
    sink and a formatted copy to `loop.log`, then the CI gate,
    then review. Remote work defers the gate with a `Waiting remote` event when its
    pending issue set changes and every ten minutes while unchanged. A light-gate cycle
    suite logs its `Started Suite` event before invoking the blocking commands. Its
    passing verdict is retained for that commit while PR setup retries, and is discarded
    as soon as the branch tip changes. Repeated gate failures remain visible with a
    count; a repeated push failure logs `ERROR`, writes the stop file, and stops retrying.
    When scanning is disabled and the local backlog plus the known shared finding set are
    empty, the gate is final because no source can produce more work; it promotes and
    exits through the same path as the scan cap. An unavailable shared finding snapshot
    remains an external source whose state is unknown, so the gate waits. An idle continuing
    status names its wait target, such as an open finding or finding status that could not
    be read. A continuing status with no scan, running task, or queued item carries the
    current idle stretch as an `Idle` event whose `Status` subject is followed by
    `Task=<n>`, `Queue=<n>`, and the duration; repeated idle statuses back off from the
    early milestones to a five-minute maximum interval, and any active work resets the
    stretch. A status with a non-zero scan, running, or queue counter omits `Waiting=`
    because the counters already explain why the poll continues and remains visible on
    every poll.
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
    body (marker gone) is never overwritten again. Body ownership does not freeze the
    generated title, which is still updated through the adapter's title-only field.
23. The body is built from commit history and therefore shows intermediate steps of
    reworked changes; `LOOP_DONE` output reminds that the summary is rewritten by hand
    from the diff before review.

## Process control

24. A PID lock (`queue/loop.pid`) keeps the loop single-instance per repository; a stale
    stop file is cleared on startup, after the PID lock is taken (never before — it may
    be another instance's signal). Before task or issue work begins, startup refuses any
    live PID left in task status by an earlier daemon. A worktree with no corresponding
    task status also blocks startup and is reported with an OS-specific handle diagnostic.
    A run which publishes work also refuses to start when its branch has no unambiguous
    push target, logging `ERROR` and writing the stop file before task or issue work.
24a. A task's runner PID is held in `queue/pids/<task-id>`, not in its status record, so
    the identifier lasts exactly as long as what it describes. Stopping a task's process
    tree releases its entry in the same step; a tree that resisted termination keeps
    its entry, because something still runs under that number. An entry written before
    the running system booted is not believed and is dropped as it is read: identifiers
    are reassigned across a restart, and a survivor would otherwise refuse a startup or
    direct a termination at a stranger. A PID left in an older status record is never
    read back.
25. The stop file (`queue/stop`) is checked at the top of every poll. `stop`, daemon stop
    outcomes, and daemon termination signals stop every live task process tree (`taskkill
    /T /F` on Windows and the detached process group on POSIX), retain task state for
    recovery, and report each terminated task or that no live task processes were found.
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
    check lines; draft-vs-ready is a forge-neutral flag. The shipped issue-queue surface
    likewise normalizes issues, comments, and author write-access verdicts. It exposes
    current-user and label discovery/creation; issue creation, lookup, open/closed
    listing, and comments; assignment and label mutation; direct closure; and merge
    message decoration for forge-driven closure. Fingerprint deduplication, claim
    arbitration, and stale-lease reaping live in `src/issueQueue.ts` on those primitives.
30. The runner is invoked only through `adapters/runner.ts` (`RUNNER=codex` selects
    `runner-codex.ts`). The runner contract is the output markers — `TASK_COMPLETE`,
    `NEXT_TASK:`, `DECISION_REQUIRED:` in the final-message file — plus effort/model
    arguments mapped to CLI flags, and the runner's own repository skill destination and
    rendering behavior inside the adapter. Any runner honoring the contract is
    substitutable, and none of them owns the interactive agent's skill directory.
31. Everything the orchestration knows about the repository it runs in — which staged
    paths select fast pre-commit checks, which commands verify a merge, which paths make
    each check relevant, which suites prove a cycle's
    tip, which toolchain breakage a reinstall repairs, and how commits and changed paths
    become pull-request sections, area labels, and risk bullets — lives in the project
    adapter (`adapters/project.ts`; with neither selection variable set, the single
    `../project/project-*.ts` file is discovered; `PROJECT=<name>` selects
    `../project/project-<name>.ts`; `PROJECT_ADAPTER` overrides the path). The
    core executes the declarations and owns the generic behavior: Git history and diff
    collection, pull-request formatting, output capture, failure attribution, and stop
    decisions. Porting the orchestration to another repository means writing a project
    adapter and nothing else. The core owns the commit-message hook and resolves the
    default-branch guard from the tracking remote's advertised HEAD, failing closed when
    it cannot; its pre-commit hook loads the adapter's `preCommitChecks` instead of
    embedding repository branch names or a repository gate in shell.

    A consumer imports the core with one deliberate `git subtree add`, then uses `init`
    as the single setup and repair command. Init generates its adapter from the same
    required-member description the real loader validates, scaffolds project templates,
    points the repository-local `core.hooksPath` at the core's hooks, and creates only
    missing `loop:*` labels. Re-running it adds and reports marked scaffold defaults for
    missing required adapter members, but never overwrites a declared member, another
    project-owned file, or a different hooks setting; divergence is reported. The
    `loop-setup` skill gathers the repository decisions, fills a newly generated adapter,
    and runs `verify-setup`. That
    verifier reports separately the core typecheck, adapter suite, real loader discovery
    by name, referenced paths, pushable upstream, hooks setting, and labels. A skipped
    check retains its reason and is never reported as a pass.
32. Operating-system behavior is detected once from the running process and exposed
    through `adapters/os.ts`. Callers receive intent-level process-tree, directory, and
    worktree-path operations from either `os-windows.ts` or `os-posix.ts`; there is no
    OS selector or platform field in the contract.

## The issue queue (new in the rewrite, opt-in)

### Trust model

The loop trusts its installed orchestration code, its operator-supplied configuration and
templates, and forge actors whom the adapter identifies as having repository write access.
Write access is the authorship boundary because repository administrators have already
authorized those accounts to change the code the loop will eventually merge. Public issue
bodies, comments, repository files, diffs, and commit messages are otherwise untrusted;
being visible in the repository or carrying a loop-shaped marker does not grant authority.
For GitHub, the adapter asks the forge for the author's repository permission and treats
`write`, `maintain`, and `admin` as the forge-neutral write-access verdict. A permission
lookup that fails for any reason other than a rate limit answers "no write access", so a
missing collaborator and an unreachable forge both resolve to untrusted rather than to a
guess.

Authorship is checked both when a ready issue is claimed and when fingerprint ownership
is reconciled. An untrusted issue remains unassigned and ready, receives
`loop:untrusted-author`, and emits a warning naming its author so a maintainer can inspect
it and re-file genuine work. An issue whose author lacks write access, or which already
carries that label, never suppresses or closes a trusted finding and is never recorded in
the local fingerprint ledger.

A task materialized from a trusted issue frames the requirement as the specification it
is, because the claim gate has already established that its author may change this
repository. That framing still withholds authority the claim cannot confer: an
instruction inside the requirement to disregard the task's own instructions, to run
commands unrelated to the change, or to read or transmit credentials is ignored and
named. A requirement asking to weaken the claim gate, the write-access check, or the
untrusted-text framing itself is refused outright however trusted its author — a
boundary movable by a request travelling through it is not a boundary, so such a change
is made by a person. Repository-controlled prose carries no such verification and keeps
the stricter framing, which additionally refuses orchestration and CI changes prompted by
it; scan and review prompts apply that rule to the text they inspect or quote. A `MERGED:` comment affects stale-lease reaping or idle detection only when its
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
33. Before claiming, worker daemons group ready findings whose titles name the same first
    path, using the same primary-path convention as fingerprinting. A group contains at
    most four issues; another batch remains ready for the next claim. Titles without a
    path stay singleton tasks. Every grouped requirement appears separately in the task
    specification and requires an exact `REQUIREMENT_COMPLETE: #N` final-response marker.
    The worker refuses to publish or merge the task until all linked issues have markers,
    so partial implementation cannot close an unaddressed finding. A grouped task that
    fails, cannot start, or reaches abandoned merge handling returns every member to ready,
    unassigned, with `loop:group-singleton`; those findings are claimed individually on
    retry rather than recreating the failed group. Fingerprints and their ledger remain per
    finding.

    Worker daemons claim a ready issue or group by self-assignment. The forge login is the
    worker identity, and every daemon that may claim concurrently must authenticate as a
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
34. The merge commit of an issue-born task carries `closes #N` for every linked issue, so
    the forge closes all of them when the promotion PR lands the commit on the default
    branch. Immediately after merging, the worker comments on every linked issue with the
    merge commit and run branch and states that closure happens on promotion; this refreshes
    `updatedAt` across the ordinary
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
    `task/<id>` to the configured push remote, comments the branch and exact head commit
    on its issue, and
    swaps `loop:in-progress` for `loop:merge-ready`. A completed inspection with no
    commits comments and closes its issue instead. Its poll status uses the shared
    `Running    Status      Task=<n>  Queue=<n>` event while work is active and appends
    `Waiting=open finding` when idle; because workers never scan, their loop-log prefix
    carries cycle zero rather than a worker-specific replacement for the cycle.
36. Exactly one normal, non-worker daemon owns the run tree and is the merger. After
    processing local completions, each stop-file-free poll adopts `loop:merge-ready`
    issues from that poll's shared finding snapshot: it reads the reported branch and head, fetches that branch
    from the configured push remote, verifies the head and that it adds commits to the
    current branch, runs
    the project adapter's path-selected checks in a detached worktree, and merges with
    `--no-ff` and `closes #N` for every issue named by a grouped worker report. It persists
    a successful adoption for every member before updating the issues, so a later poll
    retries failed metadata updates without merging again. A
    successful adoption logs aligned `Merging` and `Merged` events keyed by the short
    task id, with the latter naming the first eight characters of the merge commit;
    promotion closes the issue. A failure logs the aligned `Failed` event with the short
    task id and merge-log name. It is
    commented on the issue, swaps `loop:merge-ready` for `loop:merge-failed`, and counts
    through the consecutive-merge-failure limit instead of returning singleton work to
    ready. A failed grouped adoption instead returns all members as singleton-ready work.
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
