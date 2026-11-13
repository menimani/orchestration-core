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
- Every read-modify-write of `queue/backlog.txt` takes the backlog lock beside it, and a
  waiter gives up after 30 seconds. A lock, or the recovery mutex that serializes its
  reclamation, is broken only when its owner is stale: retired by its holder, or older
  than those 30 seconds and no longer its recorded process start. While one acquisition
  waits, it remembers the exact owner text it last verified as current and skips the
  process-identity query for that same text for one second; a changed owner text is
  verified at once, and a stale verdict, with every decision to break or reclaim, always
  comes from a fresh read and a fresh query. On Windows that query is bounded at five
  seconds, and a query that times out answers "unknown", which falls back to whether the
  recorded PID is alive.
- Contenders for the backlog lock tolerate one another's moves. A holder marks its lock
  retired only after renaming it away has failed, never before. A lock's owner record is
  created exclusively, so of two processes that each created the directory standing at
  the name, at most one becomes its owner. The main lock is broken only by moving it into
  a directory private to the recovery mutex its breaker holds, so a holder whose mutex
  another process displaced can no longer break it. A displaced mutex is removed, never
  put back. A rename, owner write, or removal that finds its path gone or taken
  (`ENOENT`, `EPERM`, `EEXIST`, `ENOTEMPTY`, or `EBUSY`) is a lost race: the attempt
  counts as not acquired and is retried, any other error propagates, and a private
  remnant left by the race is removed when it can be. A process running an older core
  can still race by acquiring without the mutex.
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
  are zero-padded, event names occupy a twelve-character column, and subjects shorter than
  twelve characters are padded so details align. Events preserve their complete first
  line; multiline traces and command output belong in the referenced task or suite log.
  A recoverable warning is deduplicated by its call site and full message: the first
  occurrence writes `WARN         <first line>` to `loop.log` and its full text,
  timestamped, to `logs/warn-detail.log`. Further occurrences are counted, and once ten
  minutes have passed since the last line for that warning, `loop.log` receives
  `WARN         <first line> repeated <n> times` and the count restarts. Warnings from
  different call sites are tracked independently. When the call site next succeeds, its
  warnings are cleared and `loop.log` receives one
  `Recovered    <operation> after <n> minutes`
  event, the whole minutes since the earliest of them first occurred; a call site with
  no active warning records nothing.
  The three machine markers
  are the exception to presentation-only output: a foreground loop also prints each
  marker as an exact standalone line, while a background loop writes that exact line to
  `logs/loop-markers.log`. The corresponding result is represented separately by an
  aligned display event in `loop.log`.
  `logs/loop.log.branch` records the run branch `loop.log` belongs to. Before a
  background loop opens `loop.log`, it compares that record with the run branch; when
  they differ, or the record is missing, an existing `loop.log` is renamed to
  `logs/loop-<branch>-<YYYYMMDD_HHMMSS>.log`, named after the recorded branch (or, without
  a record, the one in `queue/run-branch.txt`) with characters outside `[A-Za-z0-9._-]`
  replaced by `-`, and an empty `loop.log` is started. The record is then rewritten
  with the run branch. A foreground loop does not rotate the log.
- Every command except `install-skills`, whose own item below states its single option,
  accepts a global `--repo <path>` option. When present, Git resolves the
  named path to its repository root and the CLI verifies both that it is a Git repository
  and that its root contains an `orchestration/` directory before dispatch. A relative
  `--repo` or `--fleet` path resolves from the caller's directory, npm's `INIT_CWD` when
  present, since `npm run -C` moves the working directory. Without the
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
  directory at or above the caller's directory that holds `fleet.json` is the fleet. A
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
  into a repository a fleet keeps clean: into `~/.claude/skills` for interactive Claude,
  the default agent installed whatever the projects declare; into the user destination
  of the runner each declared project's `RUNNER` selects, `~/.agents/skills` for Codex;
  and into the user destination of every `sharedSkills` target the project adapter under
  `projects/<name>/project/` declares, loaded without the caller's `PROJECT` or
  `PROJECT_ADAPTER`. A project without that directory declares none. A project whose
  configuration, runner, or adapter fails to load is reported as `FAIL:` and exits
  non-zero after the others install. Their commands are rendered as
  `ORCHESTRATION_FLEET='<fleet>' npm run -C '<package>'`, and package paths as the
  package's absolute path, so they work from any of the fleet's project checkouts. Each
  destination keeps its own record of the skills the core owns, as a repository sync
  does; a skill there under the same name that the record does not list and whose
  content differs from the rendered skill is reported as `Conflict:` and left unchanged,
  and any conflict or failure exits non-zero. One whose content already matches is left
  unrecorded and unreported, and does not by itself fail the install. Installed
  skills carry no project guidance fragment. Without `--fleet`, the fleet is
  `ORCHESTRATION_FLEET` or the nearest `fleet.json` at or above the caller's directory.
  It accepts neither `--repo` nor `--project`; either one fails before installing.
- `report-upstream` requires one explicit, non-blank description. `--help` prints its
  usage, unknown flag-shaped arguments fail before forge access, and `--dry-run` prints
  the exact title and body without filing. An interactive invocation prints that same
  preview and requires confirmation; a declined confirmation never contacts the forge.
- `new`, `enqueue`, `start`, `logs`, and `merge` each take the task id as their first
  argument and, given none, print their usage and exit non-zero. `status` given no id
  lists every task and exits zero, and `queue` takes no id.
  `new <task-id>` writes the task specification template to `tasks/<task-id>.md` and
  prints `Created: <file>`; an existing specification is an error, never overwritten.
  `enqueue <task-id> [depth]` appends `<task-id>:<depth>` to `queue/backlog.txt` and
  prints `Enqueued: <task-id> (depth=<depth>)`; a depth that is not a non-negative
  integer is taken as 0, and a missing specification is an error. A task already in the
  backlog, or whose status is `running`, `completed`, `merged`, or `no-change`, is
  reported as a `WARN:` line, not queued, and exits zero. A `failed` task is queued
  again only once its worktree and branch are gone; while either remains, a `WARN:` line
  names it and the `cleanup` to run, and the command exits non-zero.
  `start <task-id> [--effort minimal|low|medium|high] [--model <model>]` creates the
  task's worktree and branch and hands the specification to the runner at once, without
  the queue, defaulting to `TASK_EFFORT` and `TASK_MODEL`; an empty model leaves the
  runner's default, any other option or effort is an error, and a scan task id runs the
  project adapter's scan worktree setup first. A task whose recorded process is alive is
  reported as already running and skipped; a worktree without a live owner is an error
  left for an explicit `cleanup`.
  `status [<task-id>]` refreshes each running task, deciding completion from its final
  message as the loop does, then prints one line per task naming its id, status, and
  PID, or that there are none; a named task without a status record exits non-zero.
  While no loop holds the queue, a running task with no process record and no completion
  marker stays running, so a graceful stop's in-flight tasks reach the next loop as
  dead at startup rather than as fresh failures.
  `queue` prints the backlog with each entry's depth, or `(empty)`, followed by the
  `status` listing.
  `logs <task-id> [-f]` prints the task's log; `-f` prints its last ten lines and then
  each byte appended to it, starting over when the file is replaced or truncated. A
  missing log is an error.
  `merge <task-id> [--yes] [--test-cmd "<cmd>"]` merges `task/<task-id>` into the current
  branch as the loop's merge does (item 8 onwards). Without `--yes` it asks first, and
  any answer but `y` or `Y` prints `Aborted.` and exits zero. `--test-cmd` replaces
  `TEST_CMD` for this merge, and without a command it prints the usage and exits 1; any
  other option is an error. A grouped task missing a
  requirement's completion marker is refused before the merge. A completed merge clears the
  current cycle's gate-complete and resume flags before its status is recorded, resets the
  consecutive merge-failure count, removes the task's gate fix state and the branches kept
  from its conflicted attempts, a branch that cannot be removed being only a `WARN:`, and,
  for an issue-born task, records the promotion and comments the merge on each linked
  issue, a failed comment being only a `WARN:`. The failure count, gate fix state, and
  kept branches are settled as soon as the merged status is recorded, so a dependency
  install that then fails or is skipped still exits non-zero but leaves nothing for a
  rerun, which reports the merge as already succeeded. A `no-change` outcome removes the same
  gate fix state and kept branches and clears the cycle's gate-complete flag. A merge
  refusal prints its reason and exits non-zero.

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

The loop caches the observed file version against its modification time and size and resolves a
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
| `CI_GATE_ENABLED` | `false` | Poll the pull request's checks at the cycle gate and generate ci-fix tasks for failures (item 16). `false` skips the CI gate. |
| `SCAN_ENABLED` | `true` | Start another scan cycle after the current backlog and gate are clear. `false` drains existing local and shared work, performs any enabled final PR promotion, and exits without starting a scan. |
| `SCAN_PARALLEL` | `2` | Requested scan processes per cycle. It must be at least 1 and is reduced at launch when the scan template has fewer numbered sections. |
| `MAX_SCAN_CYCLES` | `3` | Cycle number at which the cycle is final and the run promotes its pull request (item 13). |
| `MAX_EMPTY_SCANS` | `2` | Consecutive empty scan cycles that end the run early (item 12). |
| `MAX_GROWTH_DEPTH` | `2` | Depth bound on `NEXT_TASK:` growth chains (item 6). |
| `MAX_TOTAL_TASKS` | `50` | Bound on the total tasks `NEXT_TASK:` growth may create (item 6). |
| `REVIEW_ENABLED` | `true` | Retain the review boundary in the cycle gate. Without `AUTO_REVIEW`, that boundary records resumable state and continues on the next poll; `false` skips it. If `AUTO_PR` is also `false`, disabling this setting bypasses the cycle gate entirely. |
| `AUTO_REVIEW` | `false` | Dispatch an automatic review task at the review boundary and queue its findings as fixes (item 17). |
| `REVIEW_EFFORT` | `medium` | Reasoning effort for automatic review tasks. Accepted values are `minimal`, `low`, `medium`, and `high`. |
| `REVIEW_EVERY_N_CYCLES` | `1` | With automatic review, review every Nth cycle; the final cycle is always reviewed. It must be at least 1. |
| `MAX_REVIEW_ROUNDS` | `2` | Automatic review rounds per ordinary cycle. |
| `MAX_FINAL_REVIEW_ROUNDS` | `4` | Automatic review rounds for the final cycle; exceeding it stops the loop instead of promoting the pull request. |
| `MAX_CI_FIX_ATTEMPTS` | `2` | ci-fix tasks generated for a failing CI gate before the loop stops (item 16). |
| `MAX_BURST_FAILURES` | `3` | Task failures observed in one poll that stop the loop (item 19). |
| `MAX_CONSECUTIVE_MERGE_FAILURES` | `3` | Merge failures in a row that stop the loop (item 10). |
| `MAX_GATE_FIX_ATTEMPTS` | `1` | Handbacks a completed task gets when its own content fails merge verification twice in a row; `0` disables them (item 10). |
| `SCAN_EFFORT` | `medium` | Reasoning effort for scans. Accepted values are `minimal`, `low`, `medium`, and `high` (item 14). |
| `TASK_EFFORT` | `medium` | Reasoning effort for queued tasks without a per-task override; it does not replace the high effort of review-spawned fixes (item 14). |
| `SCAN_MODEL` | empty | When non-empty, the runner model for scans (item 14). |
| `TASK_MODEL` | empty | When non-empty, the runner model for queued tasks (item 14). |
| `FORGE` | `github` | Select the bundled `github` forge adapter or an external adapter module (item 29). |
| `RUNNER` | `codex` | Select the bundled `codex` or `claude` runner adapter, or an external adapter module. |
| `RUNNER_CLAUDE_MODEL` | `claude-opus-5` | Base model for the Claude runner when no task-specific model override applies. |
| `RUNNER_CLAUDE_MODEL_MINIMAL`, `RUNNER_CLAUDE_MODEL_LOW`, `RUNNER_CLAUDE_MODEL_MEDIUM`, `RUNNER_CLAUDE_MODEL_HIGH` | `RUNNER_CLAUDE_MODEL` | Optional Claude model mapping for each runner-neutral reasoning effort. |
| `MAX_PARALLEL` | `3` | Limit concurrently running queued-task processes and shared-issue claim capacity. It must be at least 1; scan fan-out is controlled separately by `SCAN_PARALLEL`. |
| `POLL_INTERVAL` | `30` | Maximum seconds the daemon waits between polls when no wake signal arrives. Values from 0 through 1800 are accepted; the upper bound keeps polling within the issue-heartbeat interval. |
| `TEST_CMD` | empty | When non-empty, run this command in a task worktree as its merge test and use it instead of the project adapter's path-selected merge checks. A manual merge's `--test-cmd` takes precedence. |
| `SKIP_AUTO_TEST` | `false` | When `true` and no `TEST_CMD` or `--test-cmd` is set, skip the project adapter's automatic merge checks. It does not skip the explicit test command. |
| `TASK_GATE` | `full` | `full` asks the project adapter for its full merge checks; `light` asks for reduced merge checks and runs the whole cycle suite at each cycle gate (item 9). Any other value is rejected. |
| `INTEGRATION_BRANCH` | empty | Empty retains the direct layout where the daemon checkout is also the run branch. A non-empty branch uses a separate integration worktree as the task base, merge and cycle-gate target, and pull-request source. |
| `ISSUE_QUEUE_ENABLED` | `false` | Keep the backlog in forge issues instead of local queue entries (item 33). |
| `WORKER_MODE` | `false` | Run an execution-only daemon that claims and executes shared issues (item 36). `true` requires `ISSUE_QUEUE_ENABLED=true`. |
| `MAX_ISSUE_RETRIES` | `3` | Consecutive failed tasks allowed per issue before it is parked as `loop:retry-exhausted` (item 19a). |
| `ISSUE_LEASE_HOURS` | `3` | Hours without heartbeats after which an in-progress issue is reaped back to ready (item 34). |
| `TASK_DEADLINE_HOURS` | `4` | Hours a task may stay `running` without the completion marker, measured from its status file's `started_at`, before the daemon stops its process tree and fails it (Task lifecycle item 1). `0` sets no deadline. |
| `CORE_AUTO_UPDATE` | `true` | Check and pull the shared-core subtree before each cycle. `false` skips the check and the shared skill sync. |
| `UPSTREAM_REMOTE` | package `upstreamRepo` | Remote name, Git URL or path, or GitHub `owner/repository` to fetch and subtree-pull. |
| `UPSTREAM_BRANCH` | `main` | Shared-core branch to compare and pull. |

## Task lifecycle

1. A task is `completed` once `TASK_COMPLETE` appears on its own line in the task's
   `.final` file (written by the runner through its last-message output), even if its
   runner process is still alive. Without that marker, it remains `running` while the
   process is alive and becomes `failed` when the process is gone. The daemon bounds how
   long that may last: a live task without the marker whose status file's `started_at` is
   at least `TASK_DEADLINE_HOURS` old (default 4; `0` sets no deadline) has its process
   tree stopped the way cleanup stops it — only a process whose start identity was
   captured at launch, and only once the whole tree is confirmed gone — and is then
   transitioned to `failed` with a `Task deadline exceeded:` line in its log, so the
   ordinary failure path records the failure and releases its issues. A tree that cannot
   be stopped leaves the task `running` under a counted warning, and the next poll tries
   again. The `status` command applies no deadline. Markers in the
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
   fixes, and delegated work. A task claimed from forge issues takes its prefix from the
   issue's parent: `fix-` when the parent is a review task, otherwise `auto-`. Work
   delegated in issue mode publishes its reserved `user-` id only as the issue's parent,
   so the claimed task is `auto-` and can share a claim group with scan findings that
   name the same file. Listings sort chronologically.
3. `queue/desc-index` maps a description to its current task id. The same decision
   delegated twice resolves to one task, as does a repeated finding while its indexed
   task is queued, running, completed, or failed. A failed task is not re-queued while
   its worktree or branch remains; once `cleanup` has removed them, the repeated finding
   re-admits that task. An issue claim cannot wait for that cleanup, so a claimed issue
   whose indexed task failed and still holds its worktree or branch creates a fresh task
   and updates the index. If an identical
   non-advisory finding returns after that task has merged or completed with no change, it
   creates a fresh task and updates the index; completed advisories remain deduplicated.
   A worker never merges, so in worker mode a completed task counts as finished here: a
   finding that returns to ready after it was published claims a fresh task, and a
   returning advisory is closed as a duplicate.
   A decision delegated again after its task merged or completed with no change likewise
   gets a fresh task; while that task is running or completed, `delegate` warns with its
   status and does not report it as queued.
   When generating a task specification, the description's leading category selects a
   project pitfall list: `[TEST]` selects `templates/pitfalls/tests.md`, `[DOCS]` selects
   `templates/pitfalls/docs.md`, and every other description selects
   `templates/pitfalls/code.md`. The category is read from the description's first
   paragraph with the quote marker (`> ` or a bare `>`) removed from the start of each
   line, so an imported issue's quoted title selects a list as its own tag would.
   When the selected file exists, its contents follow the
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
   retries the release successfully. A queued task outside the issue queue whose startup
   fails before any status is persisted is not failed: it is re-enqueued at its depth and
   left for a later poll. The first such failure warns; the same task failing to start
   again with no successful start in between logs `ERROR` and writes the stop file, and a
   re-enqueue that itself fails does so at once. Reconciliation runs on each poll before stale-lease
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
   A worker-mode daemon (item 36) has no gate to count against: it files a completion's
   findings before publishing it, so a filing failure is one of its publication errors,
   retried on later polls until the fifth consecutive failure marks the task failed, and
   never stops the loop.
6a. A finding whose leading tag is `[DOCS]` is held rather than dispatched when the task
    that reported it is not a review task and the daemon is not in worker mode. It is
    appended to `queue/held-documentation.txt`, one record per finding with the depth it
    would have been queued at and the task that reported it, written atomically, unless
    its fingerprint is already held or the duplicate checks of the dispatch paths find it
    already carried by a queued, running, completed, or failed task or an open finding
    issue. The daemon logs one `Deferred <task> <n> documentation finding(s) until
    the cycle's other tasks finish` event per source task. Every other finding, and every
    finding of a review task, is dispatched as item 6 describes, and a held finding still
    counts as a finding of its scan, so a scan reporting only documentation is not empty.
    When the cycle gate (item 15) finds nothing queued, running, or awaiting its merge
    and, in issue mode, no finding of the run open, claimed, or awaiting merge, a non-empty
    holding file is released before the cycle suite and review. A held finding is dropped
    first when, in issue mode, an open finding issue from an author with write access
    carries its fingerprint and either suppresses it by the rule the dispatch duplicate
    checks apply (an issue whose fix has merged suppresses only an advisory fingerprint)
    or names in its `Parent:` line a task whose findings are held, which makes it the
    issue a release of this file filed and counts it whether ready, in progress, or
    merged and awaiting promotion; or, locally, when a queued, running, completed, or
    failed task already carries it. An issue filed for an earlier observation whose fix
    has merged does not count, so a finding observed again after that fix is filed
    again. The survivors
    are rewritten atomically, one `Deduplicated docs <n> held documentation finding(s)
    already carried by an open issue` (or `task`) event is logged, and when none
    survive the file is removed and nothing is released. A filing that created its
    issue before a later forge call failed therefore never files the same findings
    again. What remains is released as one task whose
    description is the finding itself when one is held, otherwise a numbered list
    `1. <finding>` in the order held, at the greatest held depth. It is queued locally, or
    filed as one issue; an issue combining several findings is titled `Documentation
    fixes (cycle <n>)` and carries every held fingerprint. It counts once against
    `MAX_TOTAL_TASKS` and passes the ordinary merge gate. The file is truncated only after
    that task or issue exists, `Released` is logged with the count, and the cycle closes
    only once the task is terminal; documentation the task itself reports is held and
    released by the same rule within `MAX_GROWTH_DEPTH`. When the task limit or the depth bound refuses the combined task,
    the held findings are dropped with the WARN a single finding logs. The file survives
    a daemon restart on the same branch and is cleared with the rest of a run's state,
    including by the branch-change reset of item 24b.
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
    whitespace collapsed, cut at 300 characters. The tag and the paragraph are read with
    the quote marker (`> ` or a bare `>`) removed from the start of each of its lines,
    so an imported issue contributes its title. A local merge reads the requirements from
    the task's specification, framed requirements in order or else its `## Requirement`
    section; an adopted worker branch reads them from its issues. A requirement tagged
    `[SECURITY]`, an imported one by its quoted title, or naming a GHSA or CVE identifier
    contributes only
    `Why: security fix; details withheld.`, because its text describes a weakness that
    stays exploitable wherever the fix has not landed. A retry recognizes a merge it
    already applied by the exact task head and the subject alone, since the requirement
    text may have been edited in between. Task specifications ask each commit's body to
    state the problem, why the change addresses it, and how it was verified, naming no
    task id, issue number, or the orchestration.
8b. Before the rebase in item 9, a task whose agent committed off its own branch is
    adopted: when the task worktree exists and is clean, its HEAD is another local branch
    or detached, and the task branch tip is a strict ancestor of that HEAD, the task
    branch is first moved to that HEAD in one compare-and-swap ref update that succeeds
    only while the branch still points at the tip it was read at, the merge log names the
    branch the commits came from, and only then does the worktree switch to the task
    branch. A HEAD that already equals the task branch tip, as after a switch that failed
    once the ref had moved, is only switched back, with no ref update and no log line.
    The agent's branch is left in place. A HEAD
    that has diverged from the task branch, or a dirty worktree, is not adopted and meets
    the ordinary checks unchanged, so a task that committed nothing on any branch still
    fails because its merge created no commit.
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
   completes without changes, or a remote worker branch is adopted for one of its linked
   issues, every branch kept for its chain is deleted and its records are removed. Pre-merge tests are chosen from the paths the
   rebased worktree touched. `TASK_GATE=full` asks the project adapter for its full merge
   checks; `TASK_GATE=light` asks it for reduced merge checks. At each cycle-gate entry,
   light mode runs every step in the adapter's cycle suite, while full mode runs only
   cycle-suite steps that opt in with `SuiteStep.runAtEveryTaskGate`. A successful suite
   verdict is retained across gate retries only while the branch tip is unchanged.
   Light-gate attribution cost (a suite break at the gate names no task) is accepted and
   documented; the gate stops the loop rather than promote a failing tip.
   A missing-toolchain repair that fails also stops the gate and reports the adapter's
   remediation message without running the subsequent suite step.
   When a step that will run (its `requires` path exists) declares `needsDocker`, the
   gate first runs the adapter's `cycleSuiteDockerProbe` command once, bounded by its
   `timeoutMs`, before any suite step. An adapter without a probe logs
   `ERROR        cycle suite infrastructure probe is not configured`, and a probe that does not
   exit 0 logs the probe's `remediation` as an `ERROR`; either writes the stop file
   without running a suite step. A failing suite step is diagnosed from this run's suite
   log alone: the adapter's `classifyInfrastructureFailure` remediation when it
   recognizes the output, `cycle suite tool missing` when the output reports a command
   that could not be found, and `cycle suite failed` otherwise, each logged as an
   `ERROR` with the log path before the stop file is written.
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
    A merge deferred because a linked issue's claim cannot be read (item 34) likewise
    leaves this count alone, and a lost claim fails the task before its gate runs.
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
    A failure whose verification commands ran and failed (`Tests failed. Aborting merge.`)
    may be the task's own content, which no unchanged retry can pass. The first such
    failure of a local task is counted and retried unchanged, as above. Only an ordinary
    implementation task is handed back: a scan, a review, or a task marked as an inspection
    is counted as above on every verification failure. When the same implementation task
    fails verification again with no other merge failure between, while it has used fewer
    than `MAX_GATE_FIX_ATTEMPTS` (default 1) handbacks, that failure is not counted:
    the task is handed back. Its runner starts again in the existing worktree and branch
    from a follow-up specification that contains the task's original specification, states
    that its commits are in place and failed verification after being combined with the
    current run branch, carries the merge log's last at most 200 lines and 16 KiB inside
    the untrusted repository-content framing as data to diagnose, and instructs it to make
    the verification commands pass by correcting the change, to commit on the same branch,
    and never to delete, skip, or weaken a test. The log's frame markers carry an
    identifier drawn from the crypto API for each follow-up and stated once before the
    frame; after truncation, every log line that matches either marker regardless of
    case, whitespace, and invisible characters is shown neutralised with a
    `[frame-like line]` prefix, so no log text can end the frame, and no log text appears
    outside it. The earlier final message is discarded, so the follow-up states that no
    completion line from the earlier attempt counts and, for a task linked to several
    issues, names each `REQUIREMENT_COMPLETE: #N` line it must print again besides its
    completion marker. A `Handback` event names the attempt
    number. The task returns to `running` with a fresh `started_at`: it takes a parallel
    slot, appears in `loop-status`, keeps its issue claim and lease heartbeat, obeys the
    task deadline and the stop command, and when it completes its merge is attempted afresh
    without filing findings again. No issue text is re-read or re-trusted on this path.
    A handback waits, uncounted and without rerunning the gate, while every parallel slot
    is taken; a reserved handback counts as running when a poll sizes its claims and
    backlog starts, so it takes the next free slot ahead of both. The reservation and the
    start of a handback hold the task's merge guard, the one every merge of the task takes:
    while a manual `merge` of the task holds it, the poll leaves the handback for a later
    poll and starts no runner in the worktree being merged. A handed-back runner that ends
    without completing — it fails, passes the task deadline, is stopped, loses its process,
    or dies with the daemon — returns the task to `completed` as the handback found it:
    its commits and earlier final message in place, the attempt used, and its issue still
    claimed. It is neither reported failed nor released; uncommitted changes the fix run
    left stay in the worktree, and its next merge failure is counted as above. The number
    of handbacks used, whether the last attempt failed verification,
    and a reserved handback not yet started are persisted under `queue/gate-fix/` before
    the runner starts, so a daemon restart neither loses nor repeats an attempt; that state
    and the follow-up specification are removed when the task merges, completes without
    changes, or is cleaned up. A handback whose runner cannot be started spends the
    attempt and counts the failure. Never handed back: a refusal for uncommitted changes,
    a rebase or merge conflict, a failure the project adapter's
    `classifyInfrastructureFailure` or the unreachable-registry diagnosis attributes to the
    environment, a test-lock deferral, an adopted worker branch, or any failure after the
    stop file exists. Once the handbacks are used, failures are counted exactly as above;
    `MAX_GATE_FIX_ATTEMPTS=0` reproduces that behaviour event for event.
10a. A failed merge or rebase is counted or retried only once its abort is confirmed to
    have left the tree where the attempt found it. A merge into the integration worktree
    or a prospective merge worktree, for a local task or an adopted worker branch, must
    leave HEAD, the working-tree status, and the absence of an in-progress merge as they
    were before it; a pre-merge task rebase must leave the task worktree at its prior tip
    with no rebase in progress. A merge that finds a merge already in progress, an abort
    that leaves any of that state changed, or a state check that itself fails stops the
    loop at once, without consulting `MAX_CONSECUTIVE_MERGE_FAILURES` or retrying, and
    the error reports what the check found and asks for the worktree to be
    inspected and restored before orchestration restarts. A later attempt would otherwise
    merge or test against a tree nobody can describe.
11. A task that merges while a cycle gate is already waiting clears that cycle's
    complete flag, so the gate pushes and verifies again with the new commits included.
    The same merge clears the cycle's resume flag, which records that the gate has
    passed; otherwise a merge landing after the gate passed would reach promotion without
    the suite, CI, or review seeing its commits. A locally merged inspection task — a
    scan, a review, or a task queued for inspection — leaves both flags in place.
11a. After a local or remote task merge, a first-parent change to this package's
    `package.json` or `package-lock.json` runs `npm ci --no-audit --no-fund` in the
    package root. Before every install attempt the loop writes a pending record,
    `queue/orchestration-deps-pending-<hash>.json`, keyed by a hash of the package root,
    and removes it only once the install succeeds. A post-merge install first stops every
    live task process tree, since `npm ci` empties the `node_modules` those processes
    load from; each stopped task is reported failed as item 19 describes. If any tree
    survives the stop, the install is skipped rather than run underneath it: the loop
    logs a `Skipped` orchestration deps event naming the merge subject and a `WARN`
    naming the surviving tree's short task id and PID, keeps the pending record, and stops with an error asking for a restart once the process is
    gone. A successful install records the lockfile hash under `node_modules`.
    At daemon startup, after ownership is acquired and before adapters are loaded, the
    same install runs when a pending record exists — even if the recorded hash matches —
    or when that recorded hash does not match or a declared dependency is missing
    (`tests/loop-merge-recovery.test.ts` and `tests/loop.test.ts` pin the skip and the
    forced startup install). Startup synchronization is limited to the package copy inside the repository
    being orchestrated, so pointing the CLI at another checkout cannot reinstall the copy
    it is running from. Install output is captured; a failure stops the loop or startup
    with an error that names the package root and the `npm ci --no-audit --no-fund`
    repair command, without undoing an already persisted merge. The next
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
    request through the cycle's loss note, and a failed scan by itself neither resets nor
    advances the empty counter, because a failed scan is no evidence that its sections
    are clean. A finding from another scan in the same cycle still resets it.
    A scan interrupted by the operator `stop` command is the exception: the command
    records the live scan before terminating it, and the next daemon discards that scan's
    task state, rewinds the incomplete cycle, and dispatches the cycle's full scan set
    again. A stop record one cycle ahead of the counter belongs to a recovery that
    rewound the cycle but could not remove the record, or to a first-cycle scan stopped
    before a start on another branch reset the counter: either way the daemon discards
    the task state of every scan the record names, tolerating scans already gone, then
    removes the record, so none of them counts as a failure of the new run.
    A scan that dies without that stop record remains a failure.
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
    cycle on a running loop). The counter carries over a restart only on the same
    branch: a daemon started on another branch resets it to zero (item 24b). A missing persisted counter reads as zero; an existing
    counter must contain base-10 digits representing a non-negative safe integer.
    Invalid contents, including an empty file, log the state path relative to the
    orchestration state root (for example, `queue/scan-count.txt`), write the stop file,
    and stop the loop without resetting or overwriting the counter, retaining it for
    operator repair.
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
    missing, or unreadable adapter logs `Restarting   adapter     for cycle <n>` and
    replaces the daemon before continuing, so every adapter consumer changes atomically at the same
    restart-safe boundary. In integration mode the monitored source is the adapter in the
    integration worktree. The daemon then fetches the configured core upstream. It
    recovers the imported revision by first matching the current subtree tree against
    commit trees in the fetched upstream history, which preserves detection after a
    squash-import commit is itself squash-merged. When no upstream tree matches, it falls
    back to the last `git-subtree-split` whose `git-subtree-dir` matches this package's
    prefix. It compares the recovered revision with the upstream tip and, if it is behind,
    runs `git subtree pull --squash`.
    A package-file change logs an aligned `Updated      core        <old8>..<new8>` event.
    In direct layout only, it also logs `Restarting   core        for cycle <n>`, releases
    daemon ownership, and starts the package's absolute CLI entry point from the package
    directory, retaining the remaining arguments, environment, and run branch. The parent
    waits for the replacement to finish daemon initialization and logs `Restarted`; a
    failed replacement restores ownership, logs `ERROR`, and makes the parent exit nonzero.
    In integration mode, the fixed daemon continues without restarting and the pulled core
    becomes executable only in a later run, as specified in 4b. It then absorbs the default
    branch and compares the adapter again before integration setup or scan dispatch. A daemon
    otherwise runs the core code it started with. Neither check ever runs mid-cycle. A dirty
    working tree logs `WARN` and lets the cycle proceed unchanged so local divergence is
    resolved by the consumer. A failed pull aborts any in-progress merge and then verifies
    that `HEAD` is the pre-pull commit and the working tree is clean; only when the abort
    succeeded and that verification passes does it log `WARN` and let the cycle proceed on
    the old core. A failed abort, a verification that cannot run, or a repository left at
    another `HEAD` or with a dirty working tree throws, and the daemon stops before the
    cycle begins.
    At the same boundary, the package manifest's skills are rendered into every
    directory selected by an agent adapter. The runner supplies its target, and the
    project adapter supplies targets for additional interactive agents. The Codex adapter
    renders into repository root `.agents/skills/`; the Claude adapter renders into
    `.claude/skills/` and resolves only the command prefix and package path prefix
    placeholders, `{{ORCHESTRATION_COMMAND_PREFIX}}` and
    `{{ORCHESTRATION_PACKAGE_PATH_PREFIX}}`, because the canonical sources already use
    that agent's format. The package path prefix is the package directory relative to
    the repository root with a trailing `/`, and empty in the owning repository. The
    sync runs only for the repository that owns the package and for a subtree consumer.
    A fleet project runs the package from outside its checkout, so the sync is skipped and its skills come from `install-skills`.
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
    entirely untouched. A managed tree is compared with CRLF folded to LF in every file
    without a NUL byte, so a checkout that converts line endings is not rewritten.
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
    (loss note into `queue/decisions.txt`, deduped), run the cycle suite (with its
    Docker preflight and failure diagnosis, item 9), ensure/update
    the draft PR, emit `CYCLE_COMPLETE: <n>/<max>` with the PR URL to the machine-marker
    sink and a formatted copy to `loop.log`, then the CI gate,
    then review. Remote work defers the gate with a `Waiting remote` event when its
    pending issue set changes and every ten minutes while unchanged. When every pending
    issue carries `loop:merge-failed` and neither `loop:ready` nor `loop:in-progress` — a
    `loop:merge-ready` left beside it is a failure relabel that did not finish, which
    adoption skips as well — and each one's comments were read with every author's access
    determined, nothing in the loop will change them: the gate records the repair in
    `queue/decisions.txt` (deduped), logs it as an `ERROR`, and writes the stop file
    instead of waiting or promoting. A light-gate cycle
    suite logs its `Started Suite` event before invoking the blocking commands. Its
    passing verdict is retained for that commit while PR setup retries, and is discarded
    as soon as the branch tip changes. A suite step that exits 75 (the test lock wait
    timeout, see Runtime) never ran: the gate logs a WARN that the repository test lock
    stayed busy, writes no stop file, and a later poll runs the suite again. Repeated
    gate failures remain visible with a count; any repeated non-rate-limit PR-setup
    failure logs `ERROR`, writes the stop file, and stops retrying, as does a repeated
    non-rate-limit failure to read the PR's CI status (item 16). A run PR a person
    closed mid-run is such a failure: its branch still holds the run's merges, so the loop
    never opens a second PR for it.
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
    `MAX_CI_FIX_ATTEMPTS`, then stop rather than poll a gate that cannot pass. A PR status
    read that fails leaves the verdict unknown: the first non-rate-limit failure warns, a
    second in a row logs `ERROR` and writes the stop file, a successful read resets the
    count, and a forge rate limit is not counted. An open
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
    review rather than reviewing against a missing or stale base. The review reads that
    diff with the loop's own package excluded: when the package is a consumer subtree,
    its repository-relative path is explicitly out of scope and excluded from every Git
    diff/log command printed by the default review template. The exclusion and
    command-scope placeholders render empty when the package owns the repository.
    Consumer review-template overrides must retain both placeholders to retain both
    protections. The review's findings come back as `NEXT_TASK` lines that become fix
    tasks and clear the cycle flag (the gate re-verifies before the next round reads the
    corrected diff).
    The optional file `accepted-limits.md` in the project directory (`orchestration/` in
    a subtree consumer, `projects/<name>/` in a fleet) supplies findings that neither a
    scan nor a review should repeat; a missing or whitespace-only file renders as
    `(none)`. The file reaches generated scan tasks as well as review tasks. Its contents
    are repository-controlled prose and are framed as untrusted text in both, so they
    can narrow findings but cannot authorize commands, credential access, or
    orchestration and CI changes. A scan or review template without the
    `{{ACCEPTED_LIMITS}}` placeholder receives an unnumbered `## Accepted limits` section
    appended to the generated task, so a consumer's template that predates the
    placeholder still carries the accepted limits, and the numbered sections that
    `SCAN_PARALLEL` splits are unchanged.
    A review that finds nothing prints `NO_FINDINGS` on its own line instead of any
    `NEXT_TASK` line (item 30). A round is clean only because its final message has no
    actionable `NEXT_TASK` finding; `NO_FINDINGS` never makes it clean, and a final
    message carrying both logs
    `WARN         final message has NO_FINDINGS and NEXT_TASK; keeping findings` and
    keeps the findings.
    A clean review round resumes the cycle; `MAX_REVIEW_ROUNDS` bounds rounds per cycle. An ordinary
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
    while the ready operation is being confirmed, is also a successful terminal state
    when its head contains the local `HEAD`; both paths emit the normal completion
    records without another ready operation. A merged PR whose head lacks later commits
    of the run branch is not success: the loop opens a new draft PR for them, as a cycle
    does, and reopens the current cycle's gate so CI and review judge that PR before it
    is promoted. A containment check that cannot be answered is a gate failure.
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
    toward its issues' consecutive failure counts (item 19a). A task already dead when
    the daemon starts — still recorded running but with no process id, as a graceful
    shutdown leaves its in-flight tasks — is likewise reported failed without counting
    toward the burst, since it is not fresh evidence of a broken environment; it still
    counts toward its issues' consecutive failure counts. A task whose status is already
    failed when the daemon starts, with no `.failed` flag and absent from the previous
    run's announced failures (item 20) — as a `status` query after a crash or a run on
    another branch leaves it — is treated the same way: announced once, recorded
    against the cycle, and counted toward its issues' consecutive failure counts, but
    not toward the burst. A task that fails after startup counts as before.
19a. In issue-queue mode, every failed-task release increments a persistent per-issue
     consecutive failure count in the queue directory. Before `MAX_ISSUE_RETRIES`
     (default 3), the issue returns to `loop:ready`; at the bound it is unassigned and
     parked under the exclusive `loop:retry-exhausted` lifecycle label, and the loop logs
     a `Parked` event before stopping. A completed task clears the counts for its linked
     issues; in worker mode, only once its completion has been published (item 36).
     Such a release re-reads each issue first and leaves alone one that another account
     has claimed since, since a lapsed claim may have been reaped and handed elsewhere;
     an operator cleanup still releases whoever holds the issue. Each issue leaves the
     persisted release intent as soon as its own release verifies, so retrying a partial
     release never releases an issue a second time.
20. Failures are announced once per task (a `.failed` flag file), recorded against the
    cycle, and carried into the PR risks. A finished run lists the failures it announced,
    so the next run neither reports them again nor counts them toward a failure burst.

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
    be another instance's signal). A replacement that takes over its predecessor's lock
    keeps the stop file, and a stop file present when any poll other than one that
    finished the run returns stops the daemon, so a stop sent while a poll restarts it
    exits instead of handing over. The lock, a restart handover, and the issue-mode marker
    record the owner's process-start identity; a query that answers "unknown" (on Windows,
    one that times out) is asked up to three times in all, 250 ms apart, so a slow
    query never fails a daemon start or handover that a later attempt can answer, and only
    then fails with an error naming the timed-out or failed query. Before task or issue work begins, startup refuses any
    live PID an earlier daemon left in the task process registry (item 24a). A worktree with no corresponding
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
24b. `queue/run-branch.txt` records the branch a run belongs to; a stopped loop's cycle
    state belongs only to that branch. At startup, once the push target and issue queue
    are initialized and before the first poll, a recorded branch that differs from the
    checkout's current branch resets that state: the per-cycle markers (completion, suite
    tip, resume, CI fix, review round and id, `failed-<cycle>`, scan yield and
    expectation), `decisions.txt`, `pr-url.txt`, `held-documentation.txt`, and the
    empty-scan count are removed, and `scan-count.txt` and `total-task-count.txt` are
    reset to zero. Task statuses, the backlog, the description index, and the `scanned/`
    announcement markers are kept, since status files span branches. A changed or
    missing record also resets the merge-failure count to zero. A matching record keeps
    every one of these, so a loop stopped mid-cycle resumes where it was. Separately, a
    background launch archives `loop.log` to `logs/loop-<branch>-<YYYYMMDD_HHMMSS>.log`
    and starts it empty when `logs/loop.log.branch` names another branch (see the
    `loop.log` format above); a foreground run never rotates it. A current
    branch that cannot be read fails startup with nothing reset. Startup then records the
    current branch. Every poll, before it consumes the stop file (item 25), compares the
    checkout's current branch with the recorded one; a mismatch logs
    `ERROR        checkout <current> does not match run branch <recorded>`, writes the
    stop file, and stops
    before any task is started, merged, or marked scanned.
25. The stop file (`queue/stop`) is checked at the top of every poll. `stop`, daemon stop
    outcomes, and daemon termination signals stop every live task process tree (`taskkill
    /T /F` on Windows; on POSIX the detached process group gets SIGTERM, then SIGKILL if it
    outlives a five-second grace period), retain task state for recovery, and report each
    terminated task or that no live task processes were found.
    On Windows the tree is one process snapshot of parent links and creation times, and
    a process created before the process now holding its recorded parent PID is an orphan
    of an exited parent: it and its descendants are outside the tree, so a recycled PID
    never adopts them. A link whose creation times are unreadable is kept. A root the
    snapshot omitted is dated by its start identity; when that query times out or fails,
    a stop leaves out every child with a creation time still naming the root, because
    an unknown identity never widens the set beyond what a known one would confirm,
    while a liveness check keeps those links and answers `alive`. A snapshot
    that cannot be taken is taken again while waiting for the tree to exit; a tree still
    unlisted at the deadline fails as `Could not stop process tree <pid>. Its processes
    could not be listed.`, and one with survivors names them as `Still running: PID <pid>`.
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
26. The daemon holds the code it started with; `loop`, once it has launched the daemon in
    the background, prints where the log lives and how to stop.
27. `prune [--days N]` deletes logs/status/generated specs/queue markers of tasks finished
    more than N days ago, 14 when `--days` is omitted; it accepts merged and no-change tasks and never touches an
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
    selector must begin with `./`, `../`, `.\`, or `..\` on every platform; an
    unprefixed value such as `custom/forge.mjs` remains a package specifier. External
    modules export a `Forge`
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
    resolves like an external forge module, including the required `./`, `../`, `.\`, or
    `..\` prefix for a consumer-repository-relative module). External modules export a `Runner` as
    default or `runner`, or a `createRunner(options)` factory. The runner contract is
    the output markers — `TASK_COMPLETE`,
    `NO_CHANGE_WARRANTED`, `NEXT_TASK:`, `NO_FINDINGS`, `DECISION_REQUIRED:` in the
    final-message file — plus effort/model
    arguments mapped to CLI flags, and the runner's own repository skill destination and
    rendering behavior inside the adapter. `NO_FINDINGS`, a standalone line, is an
    explicit empty result from a review; it never overrides a `NEXT_TASK:` line in
    the same final message (item 17). Any runner honoring the contract is
    substitutable. Additional interactive-agent skill destinations and rendering are
    selected by the consumer's project adapter rather than assumed by the core. The Claude
    runner and an interactive Claude adapter may share a destination, which is deduplicated.
31. Everything the orchestration knows about the repository it runs in — which staged
    paths select fast pre-commit checks, which commands verify a merge, which paths make
    each check relevant, which suites prove a cycle's
    tip, which of those suites need Docker and the probe (command, timeout, remediation)
    that confirms it is reachable before they run (item 9), which toolchain breakage a
    reinstall repairs, which repository- or
    toolchain-specific command output identifies an infrastructure failure, and how
    commits and changed paths
    become pull-request sections, area labels, and risk bullets — lives in the project
    adapter (`adapters/project.ts`; with neither selection variable set, the single
    `../project/project-*.ts` file is discovered; `PROJECT=<name>` selects
    `../project/project-<name>.ts`; `PROJECT_ADAPTER` overrides the path, and a relative
    `PROJECT_ADAPTER` resolves against the project directory that holds `project/`, not
    the repository root). The
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
    through `adapters/os.ts`. Callers receive intent-level process-tree, agent-launch,
    directory, and worktree-path operations from either `os-windows.ts` or `os-posix.ts`;
    there is no OS selector or platform field in the contract.
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
guess. The adapter still tells the two apart: a missing collaborator or a read-level
permission is a verdict, while any other failure marks the author's access as undetermined.
A claim that meets an undetermined author skips that issue for the poll without labelling
it and records a counted warning, so a transient outage never quarantines a trusted
author's issue for good; the unlabelled issue keeps holding the idle gate open meanwhile.

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
so authorship and verified ancestry must both hold. A later `UNPROMOTED:` comment from an
account with write access withdraws every `MERGED:` comment before it. When whether a
`MERGED:` marker stands turns on a `MERGED:` or `UNPROMOTED:` comment whose author's access
is undetermined, stale-lease reaping leaves that lease alone for the poll. Likewise, when
the merge comment the loop would post is carried only by such an author, the adopted
issue's update and merge reconciliation wait for a later poll instead of posting it again.

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
    Only a path containing a `/` separator and ending in a file extension counts, so a
    version number such as `23.6` never reads as one; a root-level filename such as
    `README.md` or `package.json`, an extensionless path such as `.githooks/pre-commit`
    or `src/adapters/`, and a backslash-separated path are not paths here and leave the
    finding on the digest alone.
    Normalization ignores case, punctuation, whitespace, non-relational word order,
    grammatical filler, plural and selected action-word forms, and issue/commit
    references. Ordering words such as `before`, `after`, and `then` keep the terms on
    either side of them, so an inverse relationship is a different finding, and a
    repeated term counts each time; distinct terms still distinguish separate
    requirements in one file. Review findings are checked
    independently before unresolved findings are combined; a combined issue stores every
    constituent fingerprint, so it also suppresses a later individual report while
    that work remains pending. Once a non-advisory issue's task merges into the run
    branch, a later scan or review observed the post-fix tree and the same fingerprint
    becomes fresh work; advisory identifiers remain durable deduplication keys across
    merges because the same advisory recurs with different prose. Pre-granularity open
    issue bodies are interpreted from their requirement text, and their coarse local
    ledger entry is replaced when encountered, avoiding a one-time duplicate round.
34. Before claiming, every daemon with the issue queue enabled groups ready findings
    that share a task origin (scan `auto` or review `fix`), a mode (inspection or implementation), and the first path
    their titles name, using the same primary-path convention as fingerprinting (only a
    path containing a `/` separator and ending in a file extension); a
    grouped task has one identifier and one mode, so findings differing in either never
    share it. A group contains at most four issues; another batch remains ready for the
    next claim. Titles without such a path, including those naming only a root-level
    file, and issues labelled `loop:group-singleton` stay singleton tasks. Every grouped requirement appears separately in the task
    specification and requires an exact `REQUIREMENT_COMPLETE: #N` final-response marker.
    The worker refuses to publish or merge the task until all linked issues have markers,
    so partial implementation cannot close an unaddressed finding. A grouped task that
    fails or cannot start returns every member to ready, unassigned, with
    `loop:group-singleton`. One that reaches abandoned merge handling does the same for
    each member that is unassigned or still assigned to the daemon's own forge account,
    leaves a member now assigned only to another account as it is, and releases no member,
    logging a warning, when the current forge user cannot be read. Released findings are
    claimed individually on retry rather than recreating the failed group. A failed task parks a member instead
    once its per-issue retry bound is reached. Fingerprints and their ledger remain per
    finding.

    Such a daemon, the merger included, claims a ready issue or group by self-assignment.
    The forge login is the claimant's identity, and every daemon that may claim the same project's issues concurrently
    must authenticate as a distinct forge account. Under that invariant, a simultaneous claim is settled
    deterministically — the lexicographically first login wins, losers unassign
    themselves — and the winner relabels to `loop:in-progress` and materializes the
    issue as a local task through the standard template (completion marker included),
    honoring an `Effort:` field. A claimed issue whose body cannot be parsed is not
    materialized: it is quarantined from `loop:in-progress` to `loop:merge-failed` with a
    comment naming the problem and the repair (fix the body, remove `loop:merge-failed`,
    add `loop:ready`, unassign the worker, and restart the loop). The daemon records that
    reason in `queue/decisions.txt` (deduped), logs it as an `ERROR`, and writes the stop
    file, ending the poll's claims. Daemons sharing an account are indistinguishable
    and may both materialize the issue, so that configuration is unsupported. A
    linked task that is running, or completed and still holding its claim, adds a
    `Heartbeat: <ISO timestamp>` issue comment at least every
    30 minutes, moving the forge's `updatedAt` lease clock without changing the issue
    body. Outside worker mode a completed task holds its claim until its status leaves
    `completed`, which happens only on a merge or a no-change outcome, so a merge
    deferred across many polls cannot let the lease lapse; item 36 covers worker mode.
    Heartbeat timestamps are tracked locally under `queue/heartbeat`; one failed
    forge attempt logs one warning and never fails the poll. A locally mapped task that
    holds its claim is excluded from that poll's reaping even when its heartbeat fails. An in-progress
    issue without heartbeats for `ISSUE_LEASE_HOURS` (default 3) is reaped back to
    ready, unassigned, so lease expiry identifies a worker that is no longer polling
    rather than a long-running task.

    Immediately before a completed task's merge gate, the merger re-reads every issue
    linked to it. An issue already closed, or one the forge reports as deleted, is passed
    over. An open issue that is no longer `loop:in-progress`, or is back to `loop:ready`,
    was reaped and may since belong to another claimant: only those issues are unlinked
    from the task, which becomes failed instead of merged, with `Merge refused: #N no
    longer claimed by this task` in its merge log and a WARN that it cannot be merged;
    the issues it still holds then take the ordinary failed-task release. A claim that
    cannot be read defers the merge, with a WARN unless the forge was rate limited, and
    leaves the task `completed` for a later poll rather than risk closing someone else's
    issue.
35. The merge commit of an issue-born task carries `closes #N` for every linked issue, so
    the forge closes all of them when the promotion PR lands the commit on the default
    branch. A queue kept in a fleet's `issueRepository` is the exception: its issue
    numbers mean nothing in the project's repository, so the merge commit names none of
    them. Instead, each poll of the merger checks the pull request of every run branch
    that still has promotion records. Once that pull request has merged and its head
    contains a record's merge commit, the merger closes that issue with a
    `PROMOTED: <task-id>` comment naming the merge commit, run branch, and pull request,
    and logs a `Promoted` event; a merge commit the head does not contain stays open for
    a later run. It closes at most four issues at once, and a rate limit starts no
    further close. A failure to close is warned about and retried on the next poll without
    holding back that poll's claims; the issues that did close stay closed. A promoted issue the forge reports as deleted is no
    longer awaited: its promotion record is dropped, along with the task's issue map once no
    promotion of that task remains, and the promotions after it still close. In every
    issue-queue mode, separate or not, a run pull
    request closed without merging will never land its work once a later run has left its
    branch, so the merger then comments `UNPROMOTED: <task-id>` on each issue recorded
    for that run branch, naming the merge commit, run branch, and pull request, returns the issue to ready and unassigned, drops
    its promotion record the same way, and logs a `Released` event. The comment withdraws
    the issue's earlier `MERGED:` marker, so a later claim of it is reaped as usual. Workers never
    close promoted issues. Immediately after merging, the merger comments on every linked issue with the
    merge commit and run branch and states that closure happens on promotion; this refreshes
    `updatedAt` across the ordinary
    merged-but-not-promoted window. If the issue reaches the lease age before promotion,
    stale-lease reaping recognizes its promotion record and leaves the issue claimed,
    without unassigning or relabeling it, until promotion closes it. A record whose merge
    comment is already confirmed gets no further comment. For an unconfirmed record the
    reaper reposts the merge comment only when no trusted marker for it is visible, reads
    the comments back, and confirms the record once the marker is visible; a marker whose
    author's permission cannot be read leaves the record pending for a later poll. An
    ordinary forge outage
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
    detection. MERGED-marker comment reads are cached by issue number and `updatedAt`,
    except that an issue whose comments include an author whose access is undetermined
    (see the trust model) is not cached, so the next poll asks again.
    Closed lifecycle labels are reconciled at startup and once on cycle-gate entry, not on
    every idle poll. A forge rate-limit response pauses further forge calls until its
    reported reset (querying `rate_limit` when needed), logs one aligned `Waiting forge`
    event, and resumes without attributing even a long wait to the branch.
    The daemon records issue mode in
    `queue/issue-mode` so a separate `delegate` process can publish ready work for the
    daemon to claim and materialize locally, including any effort or inspection setting.
    `delegate` first resolves `ISSUE_QUEUE_ENABLED` as the daemon does, the repository's
    `config.json` over the environment, rejecting a malformed value; it reads the marker
    only when neither sets the variable. An explicit setting therefore wins in both
    directions: `delegate` follows the current setting, not the one a running daemon pinned
    at startup, so setting it to `false` while an issue-mode daemon runs sends delegated
    work to the local queue.
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
    A completed task without commits re-reads each issue the same way before closing it:
    an open issue that is no longer `loop:in-progress` without `loop:ready` is unlinked
    the same way and left open, while one an earlier attempt already closed is finished.
    Any other publication error, such as a rejected push or a failed comment or label
    change, is retried on later polls; the fifth consecutive failure marks the task failed
    with the reason in its task log. Rate-limit errors are not counted, and operator
    `cleanup` resets the count, so a re-run of the same task starts afresh.
    Its poll status uses the shared
    `Running      Status      Task=<n>  Queue=<n>` event while work is active and, when
    idle, the shared `Idle` event of item 15, whose `Status` subject is followed by
    `Task=0`, `Queue=0`, the idle duration, and `Waiting=open finding`; because workers
    never scan, their loop-log prefix
    carries cycle zero rather than a worker-specific replacement for the cycle.
36a. `worker <base-ref>` starts that daemon and takes exactly one argument; anything else
    prints its usage and exits 1. It first brings the checkout to the base ref: it fetches
    the remote the ref names (`<remote>/...` or `refs/remotes/<remote>/...`, the longest
    matching remote name winning) or, for any other ref, the current branch's tracking
    remote, and requires the ref to name a commit. A checkout behind the base ref is
    fast-forwarded and one already at it is left alone. One ahead of it is refused, since
    its local commits would fork into every task branch and reach the merger unreviewed,
    and one diverged from it is refused. With `ISSUE_QUEUE_ENABLED=true` and
    `WORKER_MODE=true` added to its environment, it then loads the updated checkout's own
    configuration code against the project's `config.json`, which overrides the
    environment, and refuses to start when that code predates worker mode or the
    configuration does not resolve it on. Only then does it launch
    `loop --approve-mode issue --daemon` through the updated checkout's CLI and exit with
    that launch's status. For a fleet project, both the configuration check and the
    launch use the fleet's running package instead of the checkout, so the fast-forward
    does not update the code they load, and the launch names the fleet and project again.
37. Exactly one normal, non-worker daemon owns the run tree and is the merger. After
    processing local completions, each stop-file-free poll adopts `loop:merge-ready`
    issues from that poll's shared finding snapshot: it reads the reported branch and head, fetches that branch
    from the configured push remote, verifies the head and that it adds commits to the
    current branch, runs
    the project adapter's path-selected checks in a detached worktree, and merges with
    `--no-ff` and `closes #N` for every issue named by a grouped worker report, unless the
    queue is kept in a fleet's `issueRepository` (item 35). It persists
    a successful adoption for every member before updating the issues, so a later poll
    retries failed metadata updates without merging again. An adopted issue leaves
    `loop:merge-ready`, and its promotion is confirmed, only once a fresh comment listing
    shows its exact `MERGED:` marker from an account with write access; a marker from an
    author whose access is undetermined does not count. Within one daemon run the marker is
    posted at most once per issue and merge commit: later polls only re-read the comments,
    and a marker still not visible as trusted, or one under an undetermined author, is
    reported once through the deduplicated warning log, keyed by the issue, and logged as
    recovered when the marker is confirmed. These per-issue promotion
    records use the schema and fail-closed repair behavior in item 35; malformed persisted
    state stops reconciliation rather than permitting a duplicate merge or issue release. A
    successful adoption logs aligned `Merging` and `Merged` events keyed by the short
    task id, with the latter naming the first eight characters of the merge commit;
    promotion closes the issue. A failure logs the aligned `Failed` event with the short
    task id and merge-log name; a failure before the task id is known — a missing worker
    branch report, a report naming an unavailable issue, or a grouped member reporting a
    different branch — logs a `WARN` naming the issue instead. Either failure is
    commented on the issue, swaps `loop:merge-ready` for `loop:merge-failed` — adding the
    failure label first and reading the issue back to confirm it holds that single
    lifecycle label, logging a WARN when it does not — and counts
    through the consecutive-merge-failure limit instead of returning singleton work to
    ready. A failed grouped adoption instead returns all members as singleton-ready work.
    As in item 10, a gate command that exits 75 never ran its tests: the adoption is
    deferred with a WARN that the repository test lock stayed busy, without the comment,
    the relabel, or a failure count, and every member stays `loop:merge-ready` for the
    next poll to adopt again.
    A worker report counts only from an author with write access. When the newest
    report-shaped comment on a member comes from an author whose access is undetermined
    (see the trust model), the adoption is deferred the same way, with a WARN naming the
    issue, and that issue's comments are not cached, so the next poll asks again.
    The run branch the promotion records is read before the merge and asked a second time
    when the first lookup fails or answers nothing; when neither answers, the adoption is
    deferred the same way, with one deduplicated WARN that the run branch could not be read
    and nothing posted to the issue, since an empty run branch is never recorded.
    A grouped member still claimed — `loop:in-progress` and not `loop:ready` — is still
    being published, even when it carries a report from an earlier task, so the poll
    skips the group and leaves every member as it is; only an unclaimed member reporting
    a different branch or head, or an unavailable member, fails the adoption.
    The shared-work label state machine is `loop:ready` → `loop:in-progress` →
    `loop:merge-ready` → closed or `loop:merge-failed`; repeated task failures take the
    `loop:in-progress` → `loop:retry-exhausted` parking branch, inspections and
    accepted no-change verdicts take the intentional `loop:in-progress` → closed shortcut,
    and a claimed issue whose body cannot be parsed takes the `loop:in-progress` →
    `loop:merge-failed` quarantine of item 34, which stops the loop.
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
    the source issue and its author, and the issue body, with every line of the title and
    the body quoted, so the project's text can neither pose as the queue issue's metadata lines nor end its
    requirement with a heading; the merge commit's `Why:` line, its security withholding,
    and the pitfall list still read the quoted title's tag and text (item 8a). `--dry-run`
    prints `Would import:` lines and files nothing; a real run prints `Imported:` lines naming the queue issue and whether it is
    ready. A claim records the source fingerprints of the issues it took, and the task's
    merge commit, local or adopted, carries the forge's closing text for those source
    issues of the project's own repository, the only issue numbers a merge in a fleet with
    a separate queue may name.

## Test coverage

The suite drives real git repositories in temporary directories. Its cycle-gate cases in
`tests/loop.test.ts` are the load-bearing ones: they pin the gate's state machine — cycle
flags, CI outcomes, review rounds, final promotion, and stop conditions.
`tests/documented-defaults.test.ts` holds the configuration tables in this file and in
`README.md` to the defaults the source resolves. The suite's global setup removes this
suite's own fixture directories older than six hours from the OS temporary directory,
writing a `stop` file into any that holds an `orchestration/queue` first, and never
touches newer or foreign entries.
