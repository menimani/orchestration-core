# Orchestration core — behavior specification

This is the contract for the orchestration core. Every numbered item is a behavior the
loop learned from a specific failure, and the vitest suite under `tests/` pins each one.
A behavior change lands with the item that describes it, in the same commit. Source
comments and other items cite items by number, so a number is never reused.

## Runtime

- TypeScript executed natively by Node >= 23.6 (type stripping): no build step, no
  `enum`/`namespace`/parameter properties or other non-erasable syntax.
- `tsc --noEmit` joins the repository checks; vitest runs the test suite.
- `npm test` runs the suite under a test lock in the Git common directory, so every
  worktree of a checkout runs it one at a time, in arrival order. A waiter gives up after
  `ORCHESTRATION_TEST_LOCK_TIMEOUT_MS` milliseconds: 15 minutes when the variable is unset
  or not a positive integer, and otherwise the configured value as given, above the
  default as well as below it. Giving up prints
  `Timed out after <ms>ms waiting for the repository test lock. Lock owner: <owner>.`
  and exits with status 75 (EX_TEMPFAIL), never 1, so a caller can tell a suite that
  never ran from one that failed.
- Before a foreground loop enters its first cycle, or a background launcher spawns its
  daemon, the CLI prints the resolved queue mode (`local` or `issue`), run branch,
  runner models and reasoning efforts, and every setting whose resolved value differs
  from its default. `--approve-mode local` or `--approve-mode issue` approves the start,
  in a terminal or not, when the named mode matches `ISSUE_QUEUE_ENABLED`. Without it, a
  terminal start requires an explicit `y` or `yes`, every other answer refusing the
  start, and a non-terminal start is refused. Missing or mismatched approval exits
  non-zero before queue, worktree, or forge access, with a mismatch naming both the
  approved and resolved modes.
- No `jq` dependency anywhere (this deletes the Windows-jq-CRLF bug class; the invariant
  it protected — values read from status files compare clean — still holds and is tested).
- Core subtree updates default on. The daemon logs whether `CORE_AUTO_UPDATE` is on or
  off at startup; `false` skips the pre-cycle check entirely, including the shared skill
  sync, so rendered skills stay as they were after a manual subtree pull. `UPSTREAM_REMOTE` defaults
  to the package's `upstreamRepo` value and selects the remote to fetch and subtree-pull;
  `UPSTREAM_BRANCH` defaults to `main`. Separately, `UPSTREAM_REPO` overrides the
  package's `upstreamRepo` value as the GitHub repository where `report-upstream` files
  the report.
- The public command surface is the runtime entries in the `scripts` block of the
  package's `package.json` (the repository-root manifest here, or
  `orchestration/ts/package.json` when installed as a subtree) — there is no shell
  wrapper. Those entries map to
  same-name dispatches in the command registry in `src/cli.ts`. The manifest also owns
  the check-only `test`, `test:linux`, and `typecheck` scripts, which are not CLI
  dispatches; the registry additionally owns the hook-only `pre-commit` dispatch, which
  is invoked by the generated Git hook rather than exposed as a package script. Run with
  no command, the CLI prints the package scripts it dispatches, leaving out `pre-commit`,
  after the installed package's command prefix relative to the repository that holds it
  (`npm run` at the package's own root, `npm run -C 'orchestration/ts'` in a subtree
  consumer). The skills
  (`loop-start`, `loop-stop`, `loop-delegate`) invoke these
  scripts through the installed package's command prefix. A background launch prints status and stop
  commands that run from any directory: `npm run -C <absolute package root> <script> --`
  followed by `--repo <repository root>`, or by `--fleet <fleet dir> --project <name>` when
  the project was selected from a fleet. It prints those commands only after the child
  has acquired the PID lock and completed initialization; a child startup error is
  returned to the launcher instead. What stays frozen:
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
- Every command except `install-skills`, whose own item below states its single option,
  accepts a global `--repo <path>` option. When present, Git resolves the
  named path to its repository root and the CLI verifies both that it is a Git repository
  and that its root contains an `orchestration/` directory before dispatch. Without the
  option, repository discovery from the working directory is unchanged. Each of those
  commands accepts one repository; `loop-status` additionally accepts repeated `--repo` options.
  For two or more repositories it emits one line per repository naming the root, loop
  running state, recorded run branch, queued count, and in-flight count. Its existing
  detailed output is unchanged for a single repository. Paths are supplied per command;
  the core stores no repository registry, configuration inventory, or checkout list.
- A fleet is a separate checkout that holds what a target repository would otherwise
  carry under `orchestration/`, so the target repository holds no orchestration files.
  Its tracked `fleet.json` declares each project as a lowercase slug with the forge
  `owner/repository` its branches go to, and its untracked `fleet.local.json` maps each
  project to this machine's checkout; a relative path resolves from the fleet. Every
  command accepts `--fleet <dir>`, and every command except `install-skills` accepts
  `--project <name>`; without `--fleet`, the nearest
  directory at or above the working directory that holds `fleet.json` is the fleet. A
  fleet project keeps its adapter, templates, `accepted-limits.md`, and `config.json`
  under `projects/<name>/`, in the layout `orchestration/` uses, and its tasks,
  worktrees, status, logs, and queue under `state/<name>/`. Combining `--repo` with
  either fleet option is an error, as is an undeclared project, a missing local mapping,
  or a mapped path that is not a Git repository. `loop-status` with a fleet and no
  project prints one line per declared project in the multi-repository format; a project
  this machine cannot resolve prints the reason instead and makes the command exit
  non-zero. Every other command except `install-skills` requires `--project`. Commands the CLI prints for a fleet
  project, and the daemon and worker launches it makes, name the fleet and project again
  instead of the repository. `init` and `verify-setup` for a fleet project configure no
  hooks in the target repository and report them as skipped. When `fleet.json` names an
  `issueRepository`, they create and check the loop labels and the project's
  `project:<name>` label there; without one, labels are reported as skipped.
  When neither fleet option nor `--repo` is given and `ORCHESTRATION_FLEET` names a fleet,
  the project is the one whose checkout on this machine contains the caller's directory:
  npm's `INIT_CWD` when present, since `npm run -C` moves the working directory, and
  otherwise the working directory. The deepest such checkout wins; outside every one,
  repository discovery is unchanged. `ORCHESTRATION_FLEET` also names the fleet for
  `--project` when `--fleet` is absent.
- `install-skills [--fleet <dir>]` installs the shared skills once per user instead of
  into a repository a fleet keeps clean: into `~/.claude/skills` for Claude and
  `~/.agents/skills` for Codex. Their commands are rendered as
  `ORCHESTRATION_FLEET='<fleet>' npm run -C '<package>'`, and package paths as the
  package's absolute path, so they work from any of the fleet's project checkouts. Each
  destination keeps its own record of the skills the core owns, as a repository sync
  does; a skill there under the same name that the record does not list is reported as
  `Conflict:` and left unchanged, and any conflict or failure exits non-zero. Installed
  skills carry no project guidance fragment. Without `--fleet`, the fleet is
  `ORCHESTRATION_FLEET` or the nearest `fleet.json` at or above the caller's directory.
  It accepts neither `--repo` nor `--project`; either one fails before installing.
- `report-upstream` requires one explicit, non-blank description. `--help` prints its
  usage, unknown flag-shaped arguments fail before forge access, and `--dry-run` prints
  the exact title and body without filing. An interactive invocation prints that same
  preview and requires confirmation; a declined confirmation never contacts the forge.

### Retained runtime configuration

`loadConfig` keeps the runner-neutral environment-variable surface that existing launch
commands use. The operator file is `orchestration/config.json`; its keys are the existing
uppercase setting names. Resolution order is file, then environment, then the defaults
below. A missing file therefore preserves the previous behavior and existing launch
commands remain valid. Use
`npm run config -- list`, `get <SETTING>`, `set <SETTING> <value>`, or `unset <SETTING>`
(with the installed package's command prefix) to read and update it. The command writes a
temporary file in the same directory and renames it into place atomically, so the loop
cannot observe a partially written file.

The loop caches the observed file version against its modification time and resolves a
setting when it is referenced. File values pass through the same validation as environment
values. A malformed file or a value that fails that validation stops the run; the error
reports the file, the affected setting (or the file contents when JSON cannot identify a
setting), and the validation or parse failure. It never answers from an earlier parse or
the environment after observing a broken file. Changes to valid live values are recorded
in the loop event log with the setting name and old and new values.

Seven settings are pinned at loop startup. A file change to one is reported as ignored and
the startup value remains active for the run:

| Setting | Why it is pinned |
|---------|------------------|
| `FORGE` | Switching forge leaves in-flight work owned by a component no longer in use. |
| `RUNNER` | Switching runner leaves in-flight work owned by a component no longer in use. |
| `ISSUE_QUEUE_ENABLED` | Changing queue mode strands issues claimed under the old mode. |
| `WORKER_MODE` | Changing worker mode strands issues claimed under the old mode. |
| `INTEGRATION_BRANCH` | Changing it splits one run across branches. |
| `UPSTREAM_REMOTE` | Changing it pulls a different core into a run already based on the original source. |
| `UPSTREAM_BRANCH` | Changing it pulls a different core into a run already based on the original source. |

Every other setting is live. Missing and empty environment values use the defaults below.
Boolean values accept only the exact
lowercase values `true` and `false`; every other non-empty value is rejected. Numeric
values must be non-negative integers, with the narrower bounds stated below.

The Claude adapter reads `RUNNER_CLAUDE_MODEL` and its four per-effort variants directly
from the process environment when the runner is loaded. These runner-specific variables
are not parsed by `loadConfig` and are not operator-file settings.

| Variable | Default | Contract |
|----------|---------|----------|
| `AUTO_MERGE` | `true` | Merge completed local task worktrees automatically. `false` leaves them completed and eligible for an explicit or later merge. |
| `AUTO_PR` | `true` | Push the run branch, create or update its draft pull request at cycle gates, and promote it with `LOOP_DONE` when the run finishes. `false` performs none of those PR operations. |
| `SCAN_ENABLED` | `true` | Start another scan cycle after the current backlog and gate are clear. `false` drains existing local and shared work, performs any enabled final PR promotion, and exits without starting a scan. |
| `SCAN_PARALLEL` | `2` | Requested scan processes per cycle. It must be at least 1 and is reduced at launch when the scan template has fewer numbered sections. |
| `MAX_EMPTY_SCANS` | `2` | Consecutive empty scan cycles that end the run early (item 12). |
| `REVIEW_ENABLED` | `true` | Retain the review boundary in the cycle gate. Without `AUTO_REVIEW`, that boundary records resumable state and continues on the next poll; `false` skips it. If `AUTO_PR` is also `false`, disabling this setting bypasses the cycle gate entirely. |
| `REVIEW_EFFORT` | `medium` | Reasoning effort for automatic review tasks. Accepted values are `minimal`, `low`, `medium`, and `high`. |
| `REVIEW_EVERY_N_CYCLES` | `1` | With automatic review, review every Nth cycle; the final cycle is always reviewed. It must be at least 1. |
| `MAX_REVIEW_ROUNDS` | `2` | Automatic review rounds per ordinary cycle. |
| `MAX_FINAL_REVIEW_ROUNDS` | `4` | Automatic review rounds for the final cycle; exceeding it stops the loop instead of promoting the pull request. |
| `MAX_CI_FIX_ATTEMPTS` | `2` | ci-fix tasks generated for a failing CI gate before the loop stops (item 16). |
| `RUNNER` | `codex` | Select the bundled `codex` or `claude` runner adapter, or an external adapter module. |
| `RUNNER_CLAUDE_MODEL` | `claude-opus-5` | Base model for the Claude runner when no task-specific model override applies. |
| `RUNNER_CLAUDE_MODEL_MINIMAL`, `RUNNER_CLAUDE_MODEL_LOW`, `RUNNER_CLAUDE_MODEL_MEDIUM`, `RUNNER_CLAUDE_MODEL_HIGH` | `RUNNER_CLAUDE_MODEL` | Optional Claude model mapping for each runner-neutral reasoning effort. |
| `MAX_PARALLEL` | `3` | Limit concurrently running queued-task processes and shared-issue claim capacity. It must be at least 1; scan fan-out is controlled separately by `SCAN_PARALLEL`. |
| `POLL_INTERVAL` | `30` | Maximum seconds the daemon waits between polls when no wake signal arrives. Values from 0 through 1800 are accepted; the upper bound keeps polling within the issue-heartbeat interval. |
| `TEST_CMD` | empty | When non-empty, run this command in a task worktree as its merge test and use it instead of the project adapter's path-selected merge checks. A manual merge's `--test-cmd` takes precedence. |
| `SKIP_AUTO_TEST` | `false` | When `true` and no `TEST_CMD` or `--test-cmd` is set, skip the project adapter's automatic merge checks. It does not skip the explicit test command. |
| `INTEGRATION_BRANCH` | empty | Empty retains the direct layout where the daemon checkout is also the run branch. A non-empty branch uses a separate integration worktree as the task base, merge and cycle-gate target, and pull-request source. |

## Task lifecycle

1. A task is `completed` once `TASK_COMPLETE` appears on its own line in the task's
   `.final` file (written by the runner through its last-message output), even if its
   runner process is still alive. Without that marker, it remains `running` while the
   process is alive and becomes `failed` when the process is gone. Markers in the
   transcript log are ignored — only the final-message file is authoritative. An ordinary
   completed task may additionally report `NO_CHANGE_WARRANTED` on its own line when its
   investigation proves the requested change is already unnecessary. A missing task
   status file means no status, but an existing file must be valid JSON with string
   `task_id`, `started_at`, `updated_at`, `worktree`, and `branch` fields and a recognized
   task state. Current writes of `merged` additionally require string `merge_commit` and
   `run_branch` fields; reads remain compatible with legacy `merged` records that predate
   those fields. Malformed JSON or any other schema mismatch is not treated as absent:
   the read fails, stopping the poll that encountered it, and the file is retained for
   operator repair.
2. Task ids are `YYYYMMDD_HHMMSS_nnn_<slug>` with `nnn` a per-day sequence; slugs end in
   `scan` for scans, are `review-c<n>` for automatic reviews of cycle `<n>`, and start
   with `ci-fix`, `auto-`, `fix-`, or `user-` for CI fixes, scan findings, review-origin
   fixes, and delegated work. Listings sort chronologically.
3. `queue/desc-index` maps a description to its current task id. The same decision
   delegated twice resolves to one task, as does a repeated finding while its indexed
   task is queued, running, completed, or retryable after failure. If an identical
   non-advisory finding returns after that task has merged or completed with no change, it
   creates a fresh task and updates the index; completed advisories remain deduplicated.
   When generating a task specification, the description's leading category selects a
   project pitfall list: `[TEST]` selects `templates/pitfalls/tests.md`, `[DOCS]` selects
   `templates/pitfalls/docs.md`, and every other description selects
   `templates/pitfalls/code.md`. When the selected file exists, its contents follow the
   shared task requirements in the generated specification; when it does not exist, no
   pitfall list is added.
4. Each task runs in its own worktree under `orchestration/worktrees/<id>` on branch
   `task/<id>`. The direct layout is the default because a consumer whose source lives
   outside the loop gains no safety from another checkout. With `INTEGRATION_BRANCH`
   set, the checkout where the daemon started is the daemon worktree and its branch,
   exact commit, and clean source tree are fixed through `LOOP_DONE`. The integration
   branch has its own worktree at `orchestration/worktrees/.integration`; task branches are cut
   from that checkout, not the daemon checkout, because they must see every prior task
   merge. Task merges, cycle gates, pull-request description and promotion all operate
   there, so no loop operation merges into the daemon branch during the run.
4a. Integration mode records the daemon branch and commit as durable run identity. A
    stop retains them. A restart resumes the same run and refuses a daemon checkout that
    moved or became dirty; commits added to the integration branch while the daemon was
    down remain work for the same run and never become executing daemon code. Project
    adapter `integrationWorktreeSetup` commands prepare the fresh integration checkout,
    including its dependencies, at startup and before each new cycle.
4b. At the idle pre-cycle boundary used for core updates, integration mode fetches the
    tracking remote's advertised default branch and merges it into the integration
    branch. The result is verified by ancestry. A fetch failure, dirty checkout, or
    conflict is warned about; a conflict is aborted and left for a person, and the cycle
    proceeds. The daemon branch is never an update target. A core subtree update made
    on the integration branch likewise becomes executable only in a later run.
5. Failure handling: emit `FAILED: <id>` with the log path to the machine-marker sink,
   with a separately formatted copy in `loop.log`; record the loss against the
   current cycle (`queue/failed-<cycle>`, once per task), never retry automatically.
   `cleanup` clears the announce markers so a manual retry is watched, not silent, but
   only after verifying that the task process stopped, the worktree directory and Git
   registration were removed (on Windows, after terminating the tree of every live process
   whose command line or executable path names the worktree, as item 25 describes), and the task branch was deleted; a failed cleanup returns
   non-zero and retains the task state for a safe retry. Operator cleanup of a scan whose
   yield the current cycle still expects records it in `queue/failed-<cycle>`, as a failed
   scan is counted, so the cycle can still close. In issue-queue mode, a successful
   operator cleanup also returns linked issues to `loop:ready` and removes their local
   task mapping. A forge failure is warned about without undoing the local cleanup; the
   cleanup leaves a durable release intent and retains the task mapping until the daemon
   retries the release successfully. Reconciliation runs on each poll before stale-lease
   reaping; three consecutive failed polls stop the loop, while a successful poll clears
   the failure streak. Persisted issue mappings, release preparations, and release intents
   are either empty or contain one positive safe integer per line. Any malformed entry
   rejects the whole list instead of being skipped; reconciliation does not perform a
   partial release or discard the file, so the complete state remains available for
   operator repair.

## Growth and decisions

6. A completed task's final message is scanned for lines beginning exactly with
   `NEXT_TASK:`. After trimming the description, a line becomes work only when it is
   non-empty, contains none of the pinned format placeholders (literal or HTML-encoded),
   is not pinned no-finding prose, and produces a task slug containing an ASCII letter
   or digit. `MAX_GROWTH_DEPTH` (default 2) and `MAX_TOTAL_TASKS` (default 50) bound the
   growth. Directives elsewhere in the transcript are ignored. The completion remains
   pending, and cannot merge or pass the cycle gate, until accepted findings are
   reconciled and the durable scanned flag is written. A scan attempt that cannot file or
   enqueue an accepted finding counts one gate failure under that completion scan's key,
   however many findings it rejected: the first warns, a repeat stops the loop rather
   than holding the completion pending forever, and a forge rate limit is not counted.
7. `DECISION_REQUIRED: <text>` is logged and carried into the PR risks, never queued.
   Dedup: a line naming a `GHSA-`/`CVE-` identifier matches on the identifier (a scan
   words the same advisory differently every cycle); a line naming neither matches on
   the whole line.

## Merging

8. A merge aborts and keeps the worktree when the worktree holds uncommitted changes or
   no new commits — an agent that forgot to commit must not silently lose its work.
   A clean ordinary task with no new commits and the exact `NO_CHANGE_WARRANTED` marker
   instead becomes `no-change`, removes its worktree and branch, and directly closes its
   linked issues; forge reconciliation must succeed first, so a failed close leaves the
   task `completed` for a later poll to retry and does not count toward the merge-failure
   limit. It counts one gate failure under that task's key instead: the first warns, a
   repeat stops the loop rather than retrying a close that can never succeed, and a forge
   rate limit is not counted. A linked issue the forge reports as deleted counts as
   already closed. Scan, review, and
   `--inspect` tasks need no marker because investigation normally produces no commits:
   one without new commits takes the same `no-change` path, closing its linked issues
   directly, since there is no merge commit to carry their closing text. A merge that
   leaves the run branch's HEAD where it was is never recorded as a merge. A
   completed task that still records a runner PID has its process tree stopped and
   verified gone before the merge can discard that PID or remove the worktree, and on
   Windows any process still naming the worktree is terminated before it is removed. A runner
   recorded without the start identity that makes stopping it safe cannot be verified at
   all, so that merge is deferred rather than failed: the task stays `completed`, one WARN
   per task names the PID, and a later poll merges once the registry entry clears. When all
   of a task's commits become empty while rebasing because their changes are already on
   the run branch, the task follows the same `no-change` completion path without
   requiring the worker to have predicted that outcome.
8a. A task's merge commit has the subject `Merge <task-id> via orchestration`, followed by
    the forge's closing text for each linked issue the merge may name. Its body records why
    the work exists, as one `Why:` line per distinct requirement: the first paragraph,
    whitespace collapsed, cut at 300 characters. A local merge reads the requirements from
    the task's specification, framed requirements in order or else its `## Requirement`
    section; an adopted worker branch reads them from its issues. A requirement tagged
    `[SECURITY]` or naming a GHSA or CVE identifier contributes only
    `Why: security fix; details withheld.`, because its text describes a weakness that
    stays exploitable wherever the fix has not landed. A retry recognizes a merge it
    already applied by the exact task head and the subject alone, since the requirement
    text may have been edited in between. Task specifications ask each commit's body to
    state the problem, why the change addresses it, and how it was verified, naming no
    task id, issue number, or the orchestration.
9. Before its merge gate, a completed local task branch is rebased onto the current run
   branch tip. This refresh is retained when a check fails, so the next attempt does not
   test the same stale branch again. A conflicting rebase is aborted and keeps both the
   task worktree and run branch clean. The task is abandoned after that first counted
   merge failure, but its commits are not: before its worktree and task branch are
   removed, the task tip is kept on `conflict/<task-id>` with a record of the run-branch
   tip, the fork point, the conflicted paths, and the run-branch commits after the fork
   point that touched them. If keeping the branch fails, the task branch and worktree
   are left in place instead. A local task is queued again under a new id, at its own
   depth and effort, as a retry whose specification names that branch, those paths, and
   those commit hashes ahead of the earlier specification; commit subjects are left out
   because they are repository-controlled text. A chain of conflicts is retried at most
   twice, after which the commits stay kept for a person. Linked issues return to ready
   before another poll can select the task again, and when this checkout claims such an
   issue again its new specification carries the same section. An issue whose chain has
   used both retries is instead parked under `loop:retry-exhausted` by the same release,
   with a `Parked` event that does not stop the loop; its record and branches are kept. When a retry merges or
   completes without changes, every branch kept for its chain is deleted and its records
   are removed. Pre-merge tests are chosen from the paths the
   rebased worktree touched. `TASK_GATE=full` asks the project adapter for its full merge
   checks; `TASK_GATE=light` asks it for reduced merge checks. At each cycle-gate entry,
   light mode runs every step in the adapter's cycle suite, while full mode runs only
   cycle-suite steps that opt in with `SuiteStep.runAtEveryTaskGate`. A successful suite
   verdict is retained across gate retries only while the branch tip is unchanged.
   Light-gate attribution cost (a suite break at the gate names no task) is accepted and
   documented; the gate stops the loop rather than promote a failing tip.
   A missing-toolchain repair that fails also stops the gate and reports the adapter's
   remediation message without running the subsequent suite step.
9a. Dependency-isolation verification is opt-in per project adapter. When
    `verifyDependencyIsolation` is `true`, a merge check that passes counts only where its
    directory satisfies its own declared Node dependencies. A worktree sits inside the
    checkout it was cut from, so Node resolves anything the worktree lacks from the
    parent's `node_modules`: an install that stopped partway produces a pass against a
    dependency tree nobody assembled, and that verdict describes neither tree. Declared
    dependencies with no `node_modules`, an npm-owned directory with no completed-install
    record, or any declared dependency absent from `node_modules` turns the pass into a
    failure that names what was borrowed. The verification follows the check rather than
    preceding it, because a check may install as its own first step. When the option is
    omitted or false, merge-check results are not subjected to this Node/npm-specific
    verification, allowing adapters with other dependency models to opt out.
9b. The core project's merge and cycle gates build `node_modules` with `npm ci` in a
    staging directory, then activate the complete tree. The working dependency tree is
    never npm's cleanup target: a failed install leaves it untouched, a failed activation
    restores it, and a busy backup left after successful activation is only warned about.
10. `MAX_CONSECUTIVE_MERGE_FAILURES` (default 3) merge failures in a row stop the loop;
    a completed task remains eligible for merge on later polls, and any successful merge
    resets the count. A durable per-task guard skips an attempt while that task's merge is
    active or after it succeeded, without changing the failure count; a failed attempt
    releases the guard so a later poll can retry. A merge deferred because a completed
    task's runner cannot be verified yet (item 8) is no failure of the work: it leaves
    this count and the task's own failure count alone, so a runner tree that lingers for
    a few minutes cannot stop the loop and terminate the tasks still running under it.
    Likewise a gate command that exits 75, the status a test lock wait timeout exits with
    (see Runtime), never ran its tests: unless another check of the same gate genuinely
    failed, the merge is deferred with a WARN that the repository test lock stayed busy,
    the task stays `completed` for the next poll to merge again, and this count does not
    advance. Every other non-zero exit is still `Tests failed. Aborting merge.`
    A conflicting pre-merge rebase is terminal for that task and contributes at most one
    failure to this count; ordinary
    gate failures remain retryable. Re-claiming completed-but-unmerged work
    requests that merge instead of silently treating the task as already processed. When
    the project adapter classifies an infrastructure failure, or the merge log names an
    unreachable registry, say which — "tests failed" misattributes an environment failure
    to the task's diff. Each gate command that fails is followed in the merge log by how it
    ended: its exit status, also in hexadecimal when outside 0-255 as Windows reports a
    crashed process, or the signal that terminated it, so a runtime crash reads differently
    from a failing test.
11. A task that merges while a cycle gate is already waiting clears that cycle's
    complete flag, so the gate pushes and verifies again with the new commits included.
    The same merge clears the cycle's resume flag, which records that the gate has
    passed; otherwise a merge landing after the gate passed would reach promotion without
    the suite, CI, or review seeing its commits. A locally merged inspection task — a
    scan, a review, or a task queued for inspection — leaves both flags in place.
11a. After a local or remote task merge, a first-parent change to this package's
    `package.json` or `package-lock.json` runs `npm ci --no-audit --no-fund` in the
    package root. A successful install records the lockfile hash under `node_modules`.
    At daemon startup, after ownership is acquired and before adapters are loaded, the
    same install runs when that recorded hash does not match or a declared dependency is
    missing. Startup synchronization is limited to the package copy inside the repository
    being orchestrated, so pointing the CLI at another checkout cannot reinstall the copy
    it is running from. Install output is captured; a failure logs a summarized `WARN`
    and stops the loop or startup without undoing an already persisted merge. The next
    daemon restart retries synchronization, and work resumes only after dependencies are
    repaired and the install succeeds.

## Scans and cycles

12. Scans start on idle (nothing queued or running), with `SCAN_PARALLEL` scans at a
    time; the value must be at least 1. A request above the number of numbered scan
    sections is reduced to that section count and reported in the event log. Scans run
    over disjoint groups of the checklist's sections. A cycle counts as empty only when
    every scan in it found nothing; `MAX_EMPTY_SCANS` consecutive empty cycles end the
    run early. The expected scan count (`queue/scan-expected-<n>`) and scan yield
    (`queue/scan-yield-<n>`) are recorded per cycle. Yields are folded into the empty
    counter once, at the gate, only when every expected scan completed successfully. A
    scan launch failure stops the loop without advancing the cycle number, discarding
    the task state of every scan that attempt had already started so the next daemon
    dispatches the cycle's full scan set again rather than inheriting scans no cycle
    accounts for. A cycle missing any expected yield stops rather than advancing to
    another cycle or completion.
    A scan the cycle recorded as failed counts towards the expected total as a delivered
    but silent yield: the cycle closes, its id still reaches the decisions and the pull
    request through the cycle's loss note, and the empty counter is neither reset nor
    advanced, because a failed scan is no evidence that its sections are clean.
    A scan interrupted by the operator `stop` command is the exception: the command
    records the live scan before terminating it, and the next daemon discards that scan's
    task state, rewinds the incomplete cycle, and dispatches the cycle's full scan set
    again. A scan that dies without that stop record remains a failure.
    For parallel scans, sections in the rendered `scan-template.md` are Markdown ATX
    headings whose text begins with a number and period (for example, `### 1. Tests`),
    and every section number must be unique; headings inside fenced code blocks do not
    count. If the rendered template has no numbered sections, the daemon warns and runs
    one full scan. If its numbered sections cannot be parsed unambiguously, the daemon
    logs an error and stops before creating the next cycle's state or starting a scan.
13. `cycle_is_final` is true when the cycle number reaches `MAX_SCAN_CYCLES`, when
    the cycle's scans all came back empty and one more empty cycle reaches
    `MAX_EMPTY_SCANS`, or when `SCAN_ENABLED` is `false`, since no scan can follow the
    cycle gate. The current cycle number lives in `queue/scan-count.txt` and is
    re-read every poll (this is also the documented lever for forcing an early final
    cycle on a running loop). A missing persisted counter reads as zero; an existing
    counter must contain base-10 digits representing a non-negative safe integer.
    Invalid contents, including an empty file, log the affected repository-relative
    state path, write the stop file, and stop the loop without resetting or overwriting
    the counter, retaining it for operator repair.
    The cap those cycles count towards is persisted separately, in
    `queue/cycle-cap.txt`, rewritten from `MAX_SCAN_CYCLES` once a startup holds the PID
    lock and owns the task lifecycle — a startup refused before that point leaves no cap
    behind — and left in place at shutdown. The daemon's own `[loop <cycle>/<cap>]` log
    prefix takes the cap from its loaded configuration, so the file exists for the
    commands that run after the daemon has gone: it is what lets `shipped` (item 18a)
    record an ending against the cap the run was actually working to, rather than
    against whatever `MAX_SCAN_CYCLES` says by then.
14. Effort defaults: scans, queued tasks, and automatic reviews all run the runner at
    medium reasoning effort. Fixes spawned by an automatic review are the exception: they
    always run at high effort because they repair findings that escaped the original
    implementation. `SCAN_EFFORT`, `TASK_EFFORT`, and `REVIEW_EFFORT`
    accept `minimal`, `low`, `medium`, or `high` and override their respective defaults;
    `TASK_EFFORT` applies to queued tasks that do not have a per-task override, so it does
    not replace the high-effort review-fix override. `SCAN_MODEL` and `TASK_MODEL`
    override the runner model, and `delegate --effort` overrides effort per task. The
    Claude runner maps effort to `RUNNER_CLAUDE_MODEL_MINIMAL`, `_LOW`, `_MEDIUM`, or
    `_HIGH`, each defaulting to `RUNNER_CLAUDE_MODEL` (`claude-opus-5`), instead of
    translating runner-neutral effort into a Claude thinking flag. It starts Claude with
    `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so the agent cannot leave a command
    running in the background when its turn ends.
14a. Immediately before a new cycle consumes its number or starts a scan, after the
    previous cycle gate has closed and while no task is running, the daemon first compares
    the selected project adapter with the exact source loaded at startup. A changed,
    missing, or unreadable adapter logs `Restarting adapter     for cycle <n>` and replaces
    the daemon before continuing, so every adapter consumer changes atomically at the same
    restart-safe boundary. In integration mode the monitored source is the adapter in the
    integration worktree. The daemon then fetches the configured core upstream. It
    recovers the imported revision by first matching the current subtree tree against
    commit trees in the fetched upstream history, which preserves detection after a
    squash-import commit is itself squash-merged. When no upstream tree matches, it falls
    back to the last `git-subtree-split` whose `git-subtree-dir` matches this package's
    prefix. It compares the recovered revision with the upstream tip and, if it is behind,
    runs `git subtree pull --squash`.
    A package-file change logs an aligned `Updated    core        <old8>..<new8>` event.
    In direct layout only, it also logs `Restarting core        for cycle <n>`, releases
    daemon ownership, and starts the package's absolute CLI entry point from the package
    directory, retaining the remaining arguments, environment, and run branch. The parent
    waits for the replacement to finish daemon initialization and logs `Restarted`; a
    failed replacement restores ownership, logs `ERROR`, and makes the parent exit nonzero.
    In integration mode, the fixed daemon continues without restarting and the pulled core
    becomes executable only in a later run, as specified in 4b. It then absorbs the default
    branch and compares the adapter again before integration setup or scan dispatch. A daemon
    otherwise runs the core code it started with. Neither check ever runs mid-cycle. A dirty
    working tree or a pull conflict logs `WARN`, aborts any in-progress merge, and lets
    the cycle proceed unchanged so local divergence is resolved by the consumer.
    At the same boundary, the package manifest's skills are rendered into every
    directory selected by an agent adapter. The runner supplies its target, and the
    project adapter supplies targets for additional interactive agents. The Codex adapter
    renders into repository root `.agents/skills/`; the Claude adapter renders into
    `.claude/skills/` and resolves only the command prefix because the canonical sources
    already use that agent's format. The sync runs only for the repository that owns the
    package and for a subtree consumer. A fleet project runs the package from outside its
    checkout, so the sync is skipped and its skills come from `install-skills`.
    Both use
    `npm run` as the command prefix in the owning repository and
    `npm run -C <package-path>` in a subtree consumer, and duplicate destinations are
    served once. The renderer supplies one named
    `{{ORCHESTRATION_PROJECT_GUIDANCE}}` injection point at the end of every shared
    `SKILL.md`. For skill `<name>`, it reads the project-owned fragment
    `project/skills/<name>.md` under the project's asset directory —
    `orchestration/project/skills/<name>.md` in a repository, outside a consumer's
    vendored package subtree, or `projects/<project>/project/skills/<name>.md` in a
    fleet — and inserts it with Markdown separation. An absent fragment renders the point
    to no bytes, preserving the prior output exactly. The sync replaces only a tree
    recorded in its
    `.orchestration-core-sync.json` managed index is core-owned, and a clean sync overwrites
    edits, deletions, and added support files in its rendered tree; repository-specific
    additions belong in the fragment. A skill absent from the managed index is
    repository-owned and remains
    entirely untouched.
    In a subtree consumer, before writing any destination, the sync verifies that every
    managed destination has no staged changes. An unverifiable or non-clean managed index
    is fatal and stops the cycle before any destination is served. A destination rendering
    failure is fatal: the remaining destinations are still written, but the cycle stops
    before task dispatch and nothing is staged or committed. Otherwise the sync stages all
    managed updates and removals and commits them as one scoped commit; a staging,
    inspection, or commit failure is fatal and stops the cycle before task dispatch, retaining any staged
    output for diagnosis.
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
    as soon as the branch tip changes. A suite step that exits 75 (the test lock wait
    timeout, see Runtime) never ran: the gate logs a WARN that the repository test lock
    stayed busy, writes no stop file, and a later poll runs the suite again. Repeated
    gate failures remain visible with a count; any repeated non-rate-limit PR-setup
    failure logs `ERROR`, writes the stop file, and stops retrying.
    When scanning is disabled and the local backlog plus the known shared finding set are
    empty, the gate is final because no source can produce more work; it promotes and
    exits through the same path as the scan cap. An unavailable shared finding snapshot
    remains an external source whose state is unknown, so the gate waits. With
    `AUTO_MERGE` in a non-worker loop, a non-inspection task still `completed` after its
    completion scan, because its merge failed or was deferred, holds the gate as
    `Waiting=merge of <task>` until a later poll merges it or marks it failed. An idle continuing
    status names its wait target, such as an open finding or finding status that could not
    be read. A continuing status with no scan, running task, or queued item carries the
    current idle stretch as an `Idle` event whose `Status` subject is followed by
    `Task=<n>`, `Queue=<n>`, and the duration; repeated idle statuses back off from the
    early milestones to a five-minute maximum interval, and any active work resets the
    stretch. In a non-worker loop over the shared issue queue, `Queue=<n>` counts the
    local backlog plus the findings of that poll's snapshot that are ready to claim, so a
    finding waiting for a free slot is visible and keeps the loop out of idle, and
    `Waiting=open finding` names only a snapshot whose findings are all unready.
    A status with a non-zero scan, running, or queue counter omits `Waiting=` because the
    counters already explain why the poll continues and remains visible on every poll.
16. The CI gate is skipped by default (`CI_GATE_ENABLED=false`): CI does not run on
    draft PRs, and a gate polling for absent checks hangs forever. When enabled:
    pending → keep polling; failure → generate a ci-fix task, up to
    `MAX_CI_FIX_ATTEMPTS`, then stop rather than poll a gate that cannot pass. An open
    PR whose reported head commit is not the local `HEAD` is pending, whatever its
    checks say, because the forge can still report the previous head after a push. A PR with
    zero checks remains unknown regardless of its age unless the project adapter
    explicitly sets `ciChecksExpected: false`. Before generating a ci-fix task, the loop
    persists its candidate task ID in a per-cycle pending-ID file. If enqueueing fails,
    the pending ID remains while the attempt count and cycle-complete flag remain
    unchanged; the next poll regenerates and retries the task with that same ID. An
    enqueue failure repeating with neither an enqueue succeeding nor the CI gate passing
    in between stops the loop, so a
    queue that never accepts the fix cannot leave the loop polling a failing PR with
    nothing queued and the attempt cap out of reach. A successful enqueue records the
    attempt, clears the cycle-complete flag, and removes the pending-ID file. Session
    cleanup also removes any remaining pending-ID file.
17. Review: `AUTO_REVIEW=true` dispatches a review task reading the whole branch diff;
    before dispatch, the loop resolves the tracked remote's default branch and refreshes
    its remote ref. If either operation fails, the loop stops without dispatching a
    review rather than reviewing against a missing or stale base.
    The optional file `accepted-limits.md` in the project directory (`orchestration/` in
    a subtree consumer, `projects/<name>/` in a fleet) supplies findings that a review
    should not repeat; a missing or whitespace-only file renders as `(none)`.
    Its contents are repository-controlled prose and are framed as untrusted text in the
    generated task, so they can narrow review findings but cannot authorize commands,
    credential access, or orchestration and CI changes.
    when the package is a consumer subtree, its repository-relative path is explicitly
    out of scope and excluded from every Git diff/log command printed by the default
    review template. The exclusion and command-scope placeholders render empty when the
    package owns the repository. Consumer review-template overrides must retain both
    placeholders to retain both protections.
    findings come back as `NEXT_TASK` lines that become fix tasks and clear the cycle
    flag (the gate re-verifies before the next round reads the corrected diff). A clean
    round resumes the cycle; `MAX_REVIEW_ROUNDS` bounds rounds per cycle. An ordinary
    cycle that still has findings at that bound logs a warning and resumes. A review
    that ends failed, or in an unknown state, without a verdict says nothing about the
    diff: the loop logs a warning and retries it within the same bound, and if the
    bound is already exhausted it stops the loop (`Stopped Loop review-cap`) rather
    than resume on a review that never produced a verdict.
    `REVIEW_EVERY_N_CYCLES` skips review on off-cycles (the next reviewed cycle still
    reads their work). When automatic review is enabled, the final cycle is always
    reviewed, and its rounds continue until one is clean, bounded by
    `MAX_FINAL_REVIEW_ROUNDS`; exceeding that stops the loop
    for a person instead of promoting a branch its own review keeps rejecting.
    Before generating a review task, the loop persists its candidate task ID in a
    per-cycle pending-ID file. If enqueueing fails, that pending ID remains and neither
    the review round nor the dispatched review ID is recorded; the next gate pass
    regenerates and retries the task with the same ID. An enqueue failure repeating
    with no review enqueue succeeding in between stops the loop, so a queue that never
    accepts the review cannot leave the loop idling at the gate with nothing
    dispatched. A successful enqueue records the round and dispatched ID, then removes
    the pending-ID file. Session cleanup also removes any remaining pending-ID file.
    Review tasks commit nothing and are exempt from the merge commit check.
18. After the final cycle passes the same gate, the PR is promoted from draft,
    unless it is already open and ready. While an open PR reports a head commit other
    than the local `HEAD`, the loop neither promotes it nor emits `LOOP_DONE`, and
    retries on the next poll. A PR found merged before promotion, or merged
    while the ready operation is being confirmed, is also a successful terminal state;
    both paths emit the normal completion records without another ready operation.
    A PR found closed before or during promotion is not success: the first observation
    warns and leaves the final gate resumable, while the same closed-state failure on the
    next poll logs `ERROR`, writes the stop file, and ends the retry. Promotion errors,
    status-query errors, and a PR that remains draft use the same two-attempt bound, and
    no `LOOP_DONE` marker is emitted until an open ready or merged state is confirmed.
    The event log names the host environment where the run verification executed and
    states that the branch was not run elsewhere. Repository adapters may also declare
    manual cross-environment checks; the log names each check and its command while
    explicitly recording that the loop did not run it for the branch.
    `LOOP_DONE: <PR URL>` is emitted to the machine-marker sink and as a formatted
    `loop.log` copy, session state is cleaned up, and the loop exits. When the run branch
    has no commits beyond the fetched default branch, the PR, CI, and review
    gates are inapplicable; the loop emits `LOOP_DONE: no changes`, cleans up, and exits.
18a. `shipped <pr-number-or-url>` records the equivalent ending for a run whose PR was
     promoted by hand. It requires exactly one positive PR number (with an optional `#`)
     or absolute HTTP(S) URL
     and refuses to run while the loop is active, because an active loop records its own
     ending after observing the already-ready or merged PR itself. Use `shipped` only
     when that automatic ending was not recorded. It performs no forge operation: it
     appends a cycle-aware `Completed Loop`
     event to `logs/loop.log`, appends the standalone marker `LOOP_DONE: <reference>`
     to `logs/loop-markers.log`, and confirms the record on stdout. The reference is
     normalized rather than copied: a number becomes `#<n>`, and a URL is written in its
     parsed form, with the scheme and host lowercased and a default port dropped. The event's cycle prefix is read back from the state the stopped daemon
     left: the cycle number from `queue/scan-count.txt` and the cap from
     `queue/cycle-cap.txt` (item 13). A missing cycle number reads as zero, and a cap no
     daemon recorded falls back to the configured `MAX_SCAN_CYCLES`.

## Failure containment

19. `MAX_BURST_FAILURES` (default 3) task failures observed in one poll stop the loop —
    the cause is the environment (network, credentials, runner CLI), and every task
    started meanwhile burns tokens reaching the same wall. Work that never ran leaves no
    diff, so nothing downstream can notice it is missing; the loop must. A task whose
    process tree the loop itself stopped before a dependency install (item 11a) is still
    reported failed and its issues released, but it counts neither toward the burst nor
    toward its issues' consecutive failure counts (item 19a).
19a. In issue-queue mode, every failed-task release increments a persistent per-issue
     consecutive failure count in the queue directory. Before `MAX_ISSUE_RETRIES`
     (default 3), the issue returns to `loop:ready`; at the bound it is unassigned and
     parked under the exclusive `loop:retry-exhausted` lifecycle label, and the loop logs
     a `Parked` event before stopping. A completed task clears the counts for its linked
     issues; in worker mode, only once its completion has been published (item 36).
20. Failures are announced once per task (a `.failed` flag file), recorded against the
    cycle, and carried into the PR risks.

## The generated pull request

21. The title reports `cycle <n>/<max>` while running and category counts when finished.
    The body is rebuilt each cycle from commit classification into the sections defined
    by `ProjectAdapter.pullRequest.categories` (generated adapters default to `Changes`),
    followed by the core-owned Reasons and Risks sections; an empty category or Reasons
    section says `- None`, and an empty Risks section says `- None identified`. Reasons
    lists the `Why:` lines of the run's task merge commits (item 8a), each once, in merge
    order. Title and body come from the same classification, so they cannot disagree.
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
    On Windows the tree is one process snapshot of parent links and creation times, and
    a process created before the process now holding its recorded parent PID is an orphan
    of an exited parent: it and its descendants are outside the tree, so a recycled PID
    never adopts them. A link whose creation times are unreadable is kept.
    A shell whose runner exited first is outside that tree, so on Windows every removal of
    a task worktree (stop recovery, merge, and `cleanup`) first terminates the tree of each
    live process whose command line or executable path contains the worktree's absolute
    path, compared case-insensitively in either slash direction, with a Git Bash or
    Cygwin drive path (`/c/...` or `/cygdrive/c/...`) read as `c:\...`. The match must
    be followed by a separator, a quote, whitespace, `;`, `,`, or the end of the text, so
    a sibling such as `task-10` never holds `task-1`. Each holder whose tree
    is terminated is logged once, with its PID, executable name, and the worktree path, in
    the log of the removal: the merge output, `cleanup`, or the loop log. A process that
    survives keeps holding the worktree: its removal fails and the task state is retained.
    Other platforms stop the runner's detached process group and do nothing further.
    Before publishing its stop file, the `stop` command durably records any live scan so
    the next daemon can discard it and restart the interrupted cycle instead of treating
    the intentional termination as a missing scan yield.
26. The daemon holds the code it started with; the wrapper prints where the log lives
    and how to stop.
27. `prune --days N` deletes logs/status/generated specs/queue markers of tasks finished
    more than N days ago; it accepts merged and no-change tasks and never touches an
    unfinished or failed task, a worktree still on disk, or a spec tracked by git.
    `--dry-run` lists without deleting.

## Delegation surface

28. `delegate "<description>" [--effort e] [--inspect]` writes a task spec from the
    description (multi-line allowed), appends the shared testing requirements, and
    enqueues it; queued work always runs ahead of the next scan. `--inspect` marks
    report-only work whose merge is not rejected for producing no commits; its
    `NEXT_TASK` findings reach the queue either way.

## Adapter seams

29. All forge access goes through `adapters/forge.ts` (`FORGE=github` selects
    `forge-github.ts`; any other selector loads an external package, file URL, absolute
    path, or consumer-repository-relative module). A consumer-repository-relative
    selector must begin with `./` or `../`; an unprefixed value such as
    `custom/forge.mjs` remains a package specifier. External modules export a `Forge`
    as default or `forge`, or a `createForge(repoRoot, report, target)` factory, so gitea/gitlab
    implementations can be added without touching the core. The target names the
    repository for branches, pull requests, and workflow runs and the repository for the
    issue queue when they are not the checkout's own; a fleet project names both, and an
    omitted name keeps the adapter's inference from the checkout. The bundled GitHub
    adapter sends pull-request and workflow calls to a named code repository, naming the
    head branch explicitly, and every queue call and write-access lookup to a named issue
    repository without asking the checkout. The interface returns
    normalized values only: PR state plus check records with
    `name`, `conclusion`, and `startedAt`, which is an ISO timestamp when the forge reports
    one and otherwise an empty string. For each check name, CI waiting discards only
    timestamped records older than the newest `startedAt`: it retains every record tied
    at that newest timestamp and every record whose timestamp is absent or invalid,
    because those records cannot be reliably ordered. This fails closed when retained
    results conflict: a pending result keeps the gate waiting, and otherwise any failure
    prevents success.
    Draft-vs-ready is a forge-neutral flag. The shipped issue-queue surface
    likewise normalizes issues, comments, and author write-access verdicts. It exposes
    current-user and label discovery/creation; issue creation, lookup, open/closed
    listing, and comments; assignment and label mutation; direct closure; and merge
    message decoration for forge-driven closure. Fingerprint deduplication, claim
    arbitration, and stale-lease reaping live in `src/issueQueue.ts` on those primitives.
    Every forge also provides issue retitling: `updateIssueTitle(issueNumber, title)`
    replaces an issue's title, and project bridges use it rather than the loop core.
30. The runner is invoked only through `adapters/runner.ts` (`RUNNER=codex` selects
    `runner-codex.ts`; `RUNNER=claude` selects `runner-claude.ts`; any other selector
    resolves like an external forge module, including the required `./` or `../` prefix
    for a consumer-repository-relative module). External modules export a `Runner` as
    default or `runner`, or a `createRunner(options)` factory. The runner contract is
    the output markers — `TASK_COMPLETE`,
    `NO_CHANGE_WARRANTED`, `NEXT_TASK:`, `DECISION_REQUIRED:` in the final-message file — plus effort/model
    arguments mapped to CLI flags, and the runner's own repository skill destination and
    rendering behavior inside the adapter. Any runner honoring the contract is
    substitutable. Additional interactive-agent skill destinations and rendering are
    selected by the consumer's project adapter rather than assumed by the core. The Claude
    runner and an interactive Claude adapter may share a destination, which is deduplicated.
31. Everything the orchestration knows about the repository it runs in — which staged
    paths select fast pre-commit checks, which commands verify a merge, which paths make
    each check relevant, which suites prove a cycle's
    tip, which toolchain breakage a reinstall repairs, which repository- or
    toolchain-specific command output identifies an infrastructure failure, and how
    commits and changed paths
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
    embedding repository branch names or a repository gate in shell. A repository with no
    project adapter of its own, such as one a fleet improves from another checkout, keeps
    the branch guard and prints `SKIP: staged-path checks; this repository has no project
    adapter` instead of failing on the missing adapter.

    A consumer imports the core with one deliberate `git subtree add`, then uses `init`
    as the single setup and repair command. Init generates its adapter from the same
    required-member description the real loader validates, scaffolds project templates,
    points the repository-local `core.hooksPath` at the core's hooks, and creates only
    missing `loop:*` labels. Re-running it adds and reports marked scaffold defaults for
    missing required adapter members, but never overwrites a declared member, another
    project-owned file, or a different hooks setting; divergence is reported. Init works
    on the adapter the loop would load: with `PROJECT` or `PROJECT_ADAPTER` set, the
    selected file rather than the single discovered one. A project name given to init
    that disagrees with `PROJECT` is reported as `DIVERGED` and `PROJECT` is used;
    several adapters with neither variable set are left unchanged and reported as
    `DIVERGED`. Either report makes init exit non-zero. The
    `loop-setup` skill gathers the repository decisions, fills a newly generated adapter,
    and runs `verify-setup`. That
    verifier reports separately the core typecheck, adapter typecheck, adapter suite,
    real loader discovery by name, referenced paths, pushable upstream, hooks setting,
    and labels. The adapter typecheck passes only when the loaded adapter is one the
    core's `tsconfig.project.json` includes; a fleet adapter or another explicit
    `PROJECT_ADAPTER` path is skipped. A skipped check retains its reason and is never
    reported as a pass.
32. Operating-system behavior is detected once from the running process and exposed
    through `adapters/os.ts`. Callers receive intent-level process-tree, directory, and
    worktree-path operations from either `os-windows.ts` or `os-posix.ts`; there is no
    OS selector or platform field in the contract.
32a. `deploy` accepts no arguments and uses the current branch, the project adapter's
    deployment workflow and revision URL, and a request-unique dispatch token. It
    dispatches that workflow and identifies only the run returned for the same workflow,
    ref, and token. Run discovery is polled for at most five minutes; after discovery,
    only that run id is polled for at most thirty minutes. Both use five-second polling
    capped to the remaining deadline. The run must complete with conclusion `success`,
    and the revision endpoint must return a successful response. Fetching that response
    and reading its body share a thirty-second deadline; reaching it aborts the request
    and fails the command. The trimmed body is compared exactly with the run's `headSha`.
    The command reports the workflow success and revision `PASS` or `FAIL`, and exits zero
    only for an exact revision match; invalid usage, a missing deployment declaration,
    any of the three timeouts, an unsuccessful workflow or revision response, and a
    revision mismatch exit non-zero.
32b. `ci-wait <pr-number> [--timeout <seconds>] [--head <sha>]` polls the forge's check
    rollup for that pull request every thirty seconds, for at most `--timeout` seconds
    (default 900). `--head` names the commit whose checks may decide the verdict, as a
    full 40- or 64-character hexadecimal SHA in either case; it defaults to
    `git rev-parse HEAD` in the repository root, because right after a push the forge
    can still report the previous head with finished checks.
    Each poll keeps, per check name, only the run with the newest valid start time; a
    check without a valid start time, and every run tied for newest, is kept, so a later
    success cannot hide a same-name failure it does not provably supersede. A verdict is
    reached only when the pull request is open, its head reported at that poll equals
    the expected head, the rollup is non-empty, no kept check is pending, and the sorted
    check names equal those of the previous poll — a rollup that is still gaining checks
    is not believed. A poll whose head differs from the expected one cannot reach a
    verdict and does not count as the previous poll for that comparison.
    When less than one interval remains, the command sleeps the remainder and polls once
    more, so a result settling in that window, or a timeout shorter than one interval,
    still reaches a verdict. On a verdict it prints `<name>: <conclusion>` per kept check
    and exits 0, or 1 when any kept check failed; it exits 2 once the budget is spent
    without one. A forge call that fails is reported on stderr as
    `ci-wait: forge poll failed: <message>` and polling continues; such a poll does not
    count as the previous poll for the name comparison. After a rate-limit failure the
    next poll waits until the reported reset, or one interval if that is later; a reset
    at or past the deadline exits 3 at once. A budget spent with a failed last poll also
    exits 3, so a forge outage is never read as a failed check. A missing or non-positive PR number, an unknown option, or an option
    without a value prints usage and exits 1. A `--timeout` that is not a non-negative
    whole number prints `ERROR: --timeout must be a non-negative number of seconds`, and
    a `--head` that is not a full SHA prints `ERROR: --head must be a full commit SHA`;
    both exit 1.

## The issue queue (opt-in)

### Trust model

The loop trusts its installed orchestration code, its operator-supplied configuration and
templates, and forge actors whom the adapter identifies as having repository write access.
Write access is the authorship boundary because repository administrators have already
authorized those accounts to change the code the loop will eventually merge. Public issue
bodies, comments, repository files, diffs, and commit messages are otherwise untrusted;
being visible in the repository or carrying a loop-shaped marker does not grant authority.
For GitHub, the adapter asks the forge for the author's permission on the queue repository and treats
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

An issue imported into a fleet's queue (item 38) is authored by whoever ran the import,
so the claim gate alone would trust any project issue. The import is therefore the trust
boundary: only an issue whose author has write access to the project may be filed ready,
and only when the operator asks for it; every other import waits under `loop:triage`,
and relabelling it ready is the operator vouching for its text.

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

33. With `ISSUE_QUEUE_ENABLED=true`, scan and review findings become forge issues
    (labels `loop:finding` + `loop:ready`) instead of local queue entries, under the
    same growth bounds. A finding is filed in the queue repository, never anywhere else:
    the repository the loop is running against, or the `issueRepository` a fleet names.
    A fleet's queue is shared by its projects, so each issue a project files also carries
    `project:<name>`, created on first use, and every issue listing the queue reads is
    narrowed to that label; one project never claims, deduplicates against, or reaps
    another project's issues. An issue is filed once per fingerprint: the advisory
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
34. Before claiming, worker daemons group ready findings that share a task origin (scan
    `auto` or review `fix`), a mode (inspection or implementation), and the first path
    their titles name, using the same primary-path convention as fingerprinting; a
    grouped task has one identifier and one mode, so findings differing in either never
    share it. A group contains at most four issues; another batch remains ready for the
    next claim. Titles without a path and issues labelled `loop:group-singleton` stay
    singleton tasks. Every grouped requirement appears separately in the task
    specification and requires an exact `REQUIREMENT_COMPLETE: #N` final-response marker.
    The worker refuses to publish or merge the task until all linked issues have markers,
    so partial implementation cannot close an unaddressed finding. A grouped task that
    fails, cannot start, or reaches abandoned merge handling returns every member to ready,
    unassigned, with `loop:group-singleton`; those findings are claimed individually on
    retry rather than recreating the failed group. A failed task parks a member instead
    once its per-issue retry bound is reached. Fingerprints and their ledger remain per
    finding.

    Worker daemons claim a ready issue or group by self-assignment. The forge login is the
    worker identity, and every daemon that may claim the same project's issues concurrently
    must authenticate as a distinct forge account. Under that invariant, a simultaneous claim is settled
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
35. The merge commit of an issue-born task carries `closes #N` for every linked issue, so
    the forge closes all of them when the promotion PR lands the commit on the default
    branch. A queue kept in a fleet's `issueRepository` is the exception: its issue
    numbers mean nothing in the project's repository, so the merge commit names none of
    them. Instead, each poll of the merger checks the pull request of every run branch
    that still has promotion records. Once that pull request has merged and its head
    contains a record's merge commit, the merger closes that issue with a
    `PROMOTED: <task-id>` comment naming the merge commit, run branch, and pull request,
    and logs a `Promoted` event; a merge commit the head does not contain stays open for
    a later run. A failure to close is warned about and retried on the next poll without
    holding back that poll's claims. A promoted issue the forge reports as deleted is no
    longer awaited: its promotion record is dropped, along with the task's issue map once no
    promotion of that task remains, and the promotions after it still close. Workers never
    close promoted issues. Immediately after merging, the worker comments on every linked issue with the
    merge commit and run branch and states that closure happens on promotion; this refreshes
    `updatedAt` across the ordinary
    merged-but-not-promoted window. If the issue reaches the lease age before promotion,
    stale-lease reaping recognizes its linked locally merged task and repeats the merge
    comment instead of unassigning or relabeling the issue. That refreshes `updatedAt`
    again, keeping the issue claimed until promotion closes it. An ordinary forge outage
    degrades a poll to local-only work. Persisted cleanup release failures are retried each
    poll and stop the loop after three consecutive failures. Labels are ensured at loop
    startup.
    Promotion retry state is one JSON object per issue at
    `queue/issue-promotion/<issueNumber>.json`. It requires non-empty string `taskId`,
    numeric `issueNumber` equal to the filename's issue number, non-empty string
    `mergeCommit`, and non-empty string `runBranch`; optional `commentConfirmed`, when
    present, is boolean. Invalid JSON, a non-object value, or any schema violation is not
    treated as absent state: issue reconciliation fails closed, leaves the record and issue
    state unchanged for repair, and resumes only after the record is repaired.
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
36. `WORKER_MODE=true` defaults off and requires `ISSUE_QUEUE_ENABLED=true`. A worker-mode
    daemon is execution-only: it never scans, enters a cycle gate, creates or updates a
    pull request, runs a review, or merges. It claims and heartbeats ready issues through
    the standard path and starts their local tasks. A completed task with commits pushes
    `task/<id>` to the configured push remote, comments the branch and exact head commit
    on its issue, and
    swaps `loop:in-progress` for `loop:merge-ready`. A completed inspection or an ordinary
    task with an explicit no-change verdict and no commits comments and closes its issue
    instead. A completed task with no linked issue, such as a delegation that fell back
    to a local task after a forge error, cannot be published, so the worker marks it
    `failed` and appends the reason to its task log, keeping its commits on `task/<id>`.
    Likewise, a completed task that can never be published as it stands — missing a
    `REQUIREMENT_COMPLETE` marker, holding uncommitted changes, or with no commits and
    neither an inspection nor a no-change verdict — becomes failed with the reason in its
    task log, so its issues take the counted release of item 19a rather than lapsing into
    a reclaim of the same task.
    A completed task keeps heartbeating its issues, and keeps them out of the stale-lease
    reaper, until its publication succeeds. Immediately before reporting, the worker re-reads
    each issue: one that is no longer open and `loop:in-progress` without `loop:ready`, and
    that does not already carry `loop:merge-ready` with this task's branch and head, is
    unlinked from the task, which becomes failed without releasing or counting that issue.
    Any other publication error, such as a rejected push or a failed comment or label
    change, is retried on later polls; the fifth consecutive failure marks the task failed
    with the reason in its task log. Rate-limit errors are not counted, and operator
    `cleanup` resets the count, so a re-run of the same task starts afresh.
    Its poll status uses the shared
    `Running    Status      Task=<n>  Queue=<n>` event while work is active and, when
    idle, the shared `Idle` event of item 15, whose `Status` subject is followed by
    `Task=0`, `Queue=0`, the idle duration, and `Waiting=open finding`; because workers
    never scan, their loop-log prefix
    carries cycle zero rather than a worker-specific replacement for the cycle.
37. Exactly one normal, non-worker daemon owns the run tree and is the merger. After
    processing local completions, each stop-file-free poll adopts `loop:merge-ready`
    issues from that poll's shared finding snapshot: it reads the reported branch and head, fetches that branch
    from the configured push remote, verifies the head and that it adds commits to the
    current branch, runs
    the project adapter's path-selected checks in a detached worktree, and merges with
    `--no-ff` and `closes #N` for every issue named by a grouped worker report, unless the
    queue is kept in a fleet's `issueRepository` (item 35). It persists
    a successful adoption for every member before updating the issues, so a later poll
    retries failed metadata updates without merging again. These per-issue promotion
    records use the schema and fail-closed repair behavior in item 35; malformed persisted
    state stops reconciliation rather than permitting a duplicate merge or issue release. A
    successful adoption logs aligned `Merging` and `Merged` events keyed by the short
    task id, with the latter naming the first eight characters of the merge commit;
    promotion closes the issue. A failure logs the aligned `Failed` event with the short
    task id and merge-log name. It is
    commented on the issue, swaps `loop:merge-ready` for `loop:merge-failed`, and counts
    through the consecutive-merge-failure limit instead of returning singleton work to
    ready. A failed grouped adoption instead returns all members as singleton-ready work.
    A grouped member still `loop:in-progress` with no worker report is still being
    published, so the poll skips the group and leaves every member as it is; only a
    different reported branch or head, or an unavailable member, fails the adoption.
    The shared-work label state machine is `loop:ready` → `loop:in-progress` →
    `loop:merge-ready` → closed or `loop:merge-failed`; repeated task failures take the
    `loop:in-progress` → `loop:retry-exhausted` parking branch, while inspections and
    accepted no-change verdicts take the intentional `loop:in-progress` → closed shortcut.
38. `import-issues [--dry-run] [--ready-trusted]` files a fleet project's open issues into
    the fleet's queue and requires a fleet whose `fleet.json` names an `issueRepository`;
    anywhere else it exits non-zero. It reads the project repository's open issues,
    excluding pull requests, judging each author's write access on the project repository,
    and files them oldest first. Each import has the fingerprint
    `source:<owner/repository>#<number>` (repository lowercased) and is filed once: an
    import already in the queue, open or closed, is reported as `Skipped:` and not filed
    again, because the merge that resolves it closes the project issue and anything else
    is for a person. A new import is labelled `loop:finding` and `loop:imported`, and
    `loop:ready` only when `--ready-trusted` is given and its author has write access to
    the project; every other import is labelled `loop:triage`, which no daemon claims,
    until an operator relabels it ready. Only a fleet queue that imports needs those two
    labels, so a real run creates them in the queue repository itself and the shared set
    that `init` and `verify-setup` manage is unchanged. Its requirement is the issue title, a line naming
    the source issue and its author, and the issue body with every line quoted, so the
    project's text can neither pose as the queue issue's metadata lines nor end its
    requirement with a heading. `--dry-run` prints `Would import:` lines and files
    nothing; a real run prints `Imported:` lines naming the queue issue and whether it is
    ready. A claim records the source fingerprints of the issues it took, and the task's
    merge commit, local or adopted, carries the forge's closing text for those source
    issues of the project's own repository, the only issue numbers a merge in a fleet with
    a separate queue may name.

## Test coverage

The suite drives real git repositories in temporary directories. Its cycle-gate cases in
`tests/loop.test.ts` are the load-bearing ones: they pin the gate's state machine — cycle
flags, CI outcomes, review rounds, final promotion, and stop conditions.
`tests/documented-defaults.test.ts` holds the configuration tables in this file and in
`README.md` to the defaults the source resolves.
