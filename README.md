# orchestration-core

An autonomous improvement loop for a software repository. It scans the codebase, turns
what it finds into tasks, runs them through an agent CLI in isolated git worktrees, merges
what passes the repository's own tests, reviews the accumulated diff when
`AUTO_REVIEW=true`, and opens the pull request — unattended, for as many cycles as you
allow.

It is deliberately made of ordinary parts: git worktrees, a text queue, forge issues, and
the tests the repository already had. Every behaviour in `SPEC.md` was learned from a
specific failure; the comments in the source name the incident rather than the pattern.

## Requirements

- Node 23.6 or later — the TypeScript sources are executed natively, with no build step
- git
- Bash on Windows (for example, Git Bash), with `bash` available on `PATH` — the bundled
  runners use it to launch npm command shims safely
- An agent CLI (the bundled runner adapters drive
  [Codex](https://openai.com/codex/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code))
- A forge CLI (the bundled forge adapter drives GitHub through `gh`)

## How a run works

```
scan → tasks → run in worktrees → test → merge → cycle gate → … → review (AUTO_REVIEW=true only) → promote
```

Each cycle scans the repository, queues what the scan reports, executes queued tasks in
parallel worktrees, and merges each one only after the tests selected for the paths it
touched pass against the branch tip. Cycles end at a gate that pushes and updates a draft
pull request. With `AUTO_REVIEW=true`, the final cycle is reviewed by an agent reading
the whole branch diff; a round that raises findings turns them into fix tasks and reads
the corrected diff again. The run ends by promoting the pull request, or, when automatic
review is enabled, by stopping for a person if that review will not converge.

Consumers may list review findings that have been explicitly accepted in the optional
`orchestration/accepted-limits.md` file. A missing or blank file contributes `(none)`.
The loop places its contents in the generated review task as untrusted repository text:
entries can exclude accepted findings, but cannot authorize commands, credential access,
or changes to orchestration and CI controls.

When the core is installed as a subtree, the default review template excludes that
vendored path from both the review instructions and every printed Git command. Defects in
the vendored core belong upstream, not in a consumer finding. A custom
`orchestration/templates/review-template.md` must retain both
`{{REVIEW_SCOPE_EXCLUSION}}` and `{{REVIEW_DIFF_SCOPE}}`; omitting either placeholder opts
out of the corresponding prose or command protection. Both render as empty strings when
this package owns the repository, so this repository's review still covers its own source.

Immediately before each cycle starts, the daemon fetches the configured shared-core
upstream and compares it with the last import of this package's subtree. If the subtree
is behind, it runs `git subtree pull --squash`. In direct layout, when package files
change, the daemon replaces itself from the package's absolute CLI path so the new cycle
uses the pulled code while retaining the arguments, environment, and run branch. The
parent reports success only after the replacement daemon finishes startup. In integration
mode, the fixed daemon continues without restarting; the pulled core becomes executable
only in a later run. The update happens only after the prior gate has closed and while no
task is running.
A project adapter is watched at that same boundary. If its loaded source has changed or
can no longer be read, the daemon replaces itself before starting the next cycle. The
replacement loads the adapter afresh, so gate and presentation behavior cannot remain
silently pinned to an adapter the repository has replaced.
The daemon otherwise runs the core code it started with. A dirty working tree or
conflicting pull is left for the consumer to resolve: the daemon warns and starts the
cycle on the old core instead of merging local divergence.

That same boundary syncs the skills declared in `skills/manifest.json` into every
directory an agent working in the repository reads them from. The selected runner adapter
supplies one — the bundled Codex adapter uses `.agents/skills/` and rewrites the sources
into Codex's own form, while the Claude adapter uses `.claude/skills/` in canonical form —
and the project adapter selects any additional interactive-agent targets. This repository
selects the bundled Claude target for `.claude/skills/`; duplicate destinations are served
only once. In a subtree consumer, the sync checks every managed destination for staged
changes before writing any of them; an unverifiable or non-clean managed index is fatal
and stops the cycle. A destination rendering failure is reported while the remaining
destinations are still served. Managed updates and removals are then staged and committed
together; a staging, inspection, or commit failure is fatal and stops the cycle before
task dispatch, leaving any staged output available for diagnosis. Loop commands are
rendered for
the installed package location (`npm run` here, `npm run -C orchestration/ts` in the
layout below).
The sync tracks the exact content it generated: a consumer edit, deletion, or added
support file is reported and retained, while repository skills absent from the manifest
are never touched. Canonical skills live outside a nested runner skill directory,
so importing the package does not expose a second qualified copy of each shared skill.

Nothing here decides that shipping is safe. Deployment stays a human action.

## Consumer adapters

The core knows nothing about your forge, your agent CLI, or your repository. Three seams
carry the consumer-selected parts of that:

| Adapter | Selector | Valid selector value | Bundled implementation | Replace it to… |
|---------|----------|----------------------|------------------------|----------------|
| forge   | `FORGE`  | `github` or an external module selector | `forge-github` (`gh`)  | move to Gitea, GitLab, … |
| runner  | `RUNNER` | `codex`, `claude`, or an external module selector | `runner-codex`, `runner-claude` | drive a different agent CLI |
| project | discovery or `PROJECT` | project name | none — you write it | describe *your* repository |

The project adapter is the one you must supply. It lives **outside** this package so a
`git subtree pull` never touches it:

```
your-repo/
  orchestration/
    project/project-<name>.ts   ← yours: gates, suites, PR classification and risk signals
    templates/                  ← yours: what a scan looks for in this repository
    ts/                         ← this package, pulled as a subtree
```

With neither variable set, the core uses the single `project-*.ts` file in
`orchestration/project/`. If that directory has multiple adapters, set `PROJECT=<name>`
to select `project-<name>.ts`. You can instead give `PROJECT_ADAPTER` an explicit path;
it overrides the conventional path selected by `PROJECT`.

An external `FORGE` or `RUNNER` selector may be a package specifier, file URL, absolute
path, or path relative to the consumer repository root. A forge module exports a `Forge`
as its default or `forge` export, or exports `createForge(repoRoot, report)`. A runner
module likewise exports a `Runner` as its default or `runner` export, or exports
`createRunner(options)`. Factories may be asynchronous.

A project adapter answers a few questions: which interactive agents receive shared skills,
which staged-path checks run before a commit,
which commands gate a merge, which tests a changed path implies, which suites run once per
cycle, which repository or toolchain output identifies an infrastructure failure, how
commits are grouped in the generated pull request, which changed paths signal risk, and
how a deployment is verified. The core supplies commit subjects, changed and
deleted paths, and an on-demand diff reader; the adapter supplies the repository
vocabulary and path rules. If the repository intentionally has no PR checks, it may
explicitly declare
`ciChecksExpected: false`; otherwise zero checks never satisfy an enabled CI gate.
The core-owned pre-commit hook keeps its branch guard repository-neutral by reading the
tracking remote's advertised default branch. It fails closed when that branch cannot be
resolved, so repositories using names such as `trunk` receive the same protection without
putting repository-specific branch names in the core.

Operating-system behavior has its own internal adapter. The core detects Windows or
POSIX once when it starts; it is not a consumer choice and has no environment selector.

## Using it

```bash
git subtree add --prefix=orchestration/ts \
  https://github.com/menimani/orchestration-core.git main --squash
npm ci --prefix orchestration/ts
node orchestration/ts/src/cli.ts init <project-name>
```

The subtree command is intentionally manual: it makes the imported commit visible. After
that one deliberate import, `init` is the supported setup and repair path. It generates a
contract-valid adapter, project templates, points `core.hooksPath` at the core-owned
hooks, and creates missing `loop:*` labels. It is safe to repeat: missing required adapter
members are added with marked scaffold defaults, while declared members, other existing
project files, and a deliberately different hooks setting are reported and never overwritten.
For `SCAN_PARALLEL` greater than one, keep the scan checklist as uniquely numbered
Markdown headings outside fenced code blocks; without numbered headings the loop warns
and runs one full scan, while ambiguous numbering stops the loop before the cycle starts.

Use the repository's `loop-setup` skill to collect the project-specific decisions, fill
the generated adapter, and run `verify-setup`. The verifier reports the TypeScript gate,
adapter suite, real adapter discovery, referenced paths, pushable branch upstream, hooks
setting, and labels separately; skipped checks retain their reason.

Then start a run on a topic branch — never on your default branch, because the loop
commits and merges on its own. On POSIX shells:

```bash
MAX_SCAN_CYCLES=12 MAX_PARALLEL=8 AUTO_REVIEW=true \
  node orchestration/ts/src/cli.ts loop --approve-mode local --daemon
```

On Windows PowerShell (with `bash` on `PATH` as described above):

```powershell
$env:MAX_SCAN_CYCLES = '12'
$env:MAX_PARALLEL = '8'
$env:AUTO_REVIEW = 'true'
node orchestration/ts/src/cli.ts loop --approve-mode local --daemon
```

The default branch layout remains direct: the topic branch where the daemon starts is
also the branch tasks derive from, merge into, and promote. That keeps the existing
single-worktree shape for consumers whose source is not the loop. Repositories where the
loop runs its own source can freeze the daemon checkout by naming a separate run branch:

```bash
INTEGRATION_BRANCH=feature/current-run node src/cli.ts loop --approve-mode local --daemon
```

Every start prints the resolved queue mode, run branch, runner models and efforts, and
settings that differ from their defaults. In a terminal, the loop starts only after an
explicit `y` or `yes`. A non-interactive caller must pass `--approve-mode local` for the
default local backlog or `--approve-mode issue` when `ISSUE_QUEUE_ENABLED=true`. A
missing flag or a flag that does not match the resolved mode exits non-zero before the
loop touches the queue, worktrees, or forge.

With `INTEGRATION_BRANCH` set, the original repository checkout is the daemon worktree
and stays on its exact starting commit until the run ends. The loop creates or resumes
the integration worktree at `orchestration/worktrees/.integration`; task worktrees remain at
`orchestration/worktrees/<id>`, but Git cuts them from the integration checkout so they
include every earlier merge. Merges, cycle suites, the pull request, and `LOOP_DONE`
promotion all use the integration branch. The project adapter's
`integrationWorktreeSetup` commands install dependencies in that fresh checkout; the
operator does not prepare it by hand. Human fixes made during the run should branch from
and merge into the integration branch as well, where the next task can see them.
Immediately before a completed local task enters its merge gate, the loop rebases that
task branch onto the current integration tip. Long-running tasks therefore test the work
that has landed while they were running instead of repeatedly presenting the same stale
branch to the gate. If every task commit becomes empty because that work already landed,
the task completes as no-change and its linked issues are closed normally.

A stopped daemon retains both branch identities and the daemon commit. Restarting is a
resume of the same run: integration commits made while it was down remain available to
later tasks, but a changed daemon branch or commit is rejected instead of silently
running different machinery. Immediately before each new cycle, the integration branch
fetches and merges the remote's advertised default branch. A conflict is aborted and
warned about for a person to resolve, and the cycle proceeds without that merge. The
daemon branch is never updated at this boundary.

When a run finishes with no commits beyond the fetched default branch, there is no pull
request for the forge to create. The loop skips the inapplicable PR, CI, and review gates,
records `LOOP_DONE: no changes`, and exits normally.

`node orchestration/ts/src/cli.ts` with no arguments lists every command: `init` repairs
the adoption scaffold, `verify-setup` checks it, `delegate` hands a decision from your own
head to the loop, `loop-status` says what is in flight, `ci-wait` waits on a pull request's
checks without believing a partial rollup, and `deploy` dispatches a deployment workflow
and verifies the revision that actually came up.

If you promote a run's pull request by hand, record that completed run with
`npm run shipped -- <pr-number-or-url>` (or the equivalent direct `node` command for a
subtree installation). The command requires exactly one positive PR number, optionally
prefixed with `#`, or one absolute HTTP(S) URL. It refuses to run while the loop is active,
performs no forge operation, records the completion in `logs/loop.log`, and emits the exact
standalone `LOOP_DONE: <pr-number-or-url>` marker to `logs/loop-markers.log`.

Automatic pulls are enabled by default. To pull later improvements manually, or when
`CORE_AUTO_UPDATE=false` pins the consumed version, use:

```bash
git subtree pull --prefix=orchestration/ts \
  https://github.com/menimani/orchestration-core.git main --squash
```

## Settings worth knowing

Runtime settings can be stored in `orchestration/config.json`, using the uppercase names
below. The loop resolves file values first, then environment variables, then defaults, so
existing launch commands and repositories without the file behave unchanged. Manage the
file with `npm run config -- list`, `npm run config -- get TASK_GATE`,
`npm run config -- set TASK_GATE light`, and `npm run config -- unset TASK_GATE`; use the
equivalent package-prefixed command for a subtree installation.

The Claude-specific model variables in the table are exceptions: the Claude adapter
reads them directly from the process environment when it is loaded, so they are not
settings in `orchestration/config.json`. `UPSTREAM_REPO` is also environment-only: it
overrides the package `upstreamRepo` value for the `report-upstream` command and cannot
be stored in `orchestration/config.json`.

Configuration commands publish updates atomically through a temporary file in the same
directory, so readers cannot observe a partial write. The file is checked when a setting
is used and reparsed only after its modification time changes. A malformed file or an
invalid value stops the run and reports the file, setting, and failure instead of using an
older or environment value. Valid live changes are logged with their old and new values.
`FORGE` and `RUNNER` are pinned because
switching their owning component abandons in-flight work; `ISSUE_QUEUE_ENABLED` and
`WORKER_MODE` are pinned because changing modes strands claims; `INTEGRATION_BRANCH` is
pinned to avoid splitting a run across branches; and `UPSTREAM_REMOTE` and
`UPSTREAM_BRANCH` are pinned to keep a run on the core source it started from. All other
settings update at their next use.

| Variable | Default | Effect |
|----------|---------|--------|
| `MAX_SCAN_CYCLES` | 3 | Scan-and-fix rounds before the pull request is promoted |
| `MAX_PARALLEL` | 3 | Ordinary task agent processes at once; scan agents use `SCAN_PARALLEL` independently |
| `SCAN_PARALLEL` | 2 | Scan agent processes started together per scan cycle (1-4), independent of `MAX_PARALLEL` |
| `TASK_GATE` | full | `light` uses project-adapter-selected reduced checks for each merge, followed by the adapter's cycle suite once per cycle; `runAtEveryTaskGate` lets individual suite steps opt into every mode |
| `AUTO_REVIEW` | false | Enable agent review of cycle diffs and queue the findings as fixes |
| `REVIEW_EVERY_N_CYCLES` | 1 | With `AUTO_REVIEW=true`, review every Nth cycle and always review the final cycle |
| `CI_GATE_ENABLED` | false | Enable polling PR checks and queueing CI-fix tasks; when false, the CI gate is skipped |
| `ISSUE_QUEUE_ENABLED` | false | Keep the backlog in forge issues so several machines can share it |
| `MAX_ISSUE_RETRIES` | 3 | Consecutive failed tasks allowed per issue before it is parked as `loop:retry-exhausted` |
| `SCAN_EFFORT` / `TASK_EFFORT` / `REVIEW_EFFORT` | medium / medium / medium | Reasoning effort per kind of work; `TASK_EFFORT` applies to queued tasks without a per-task override, while review-spawned fixes always use high effort |
| `RUNNER` | codex | Agent CLI adapter; accepts `codex`, `claude`, or an external module selector |
| `RUNNER_CLAUDE_MODEL` | claude-opus-5 | Base Claude model used when `RUNNER=claude` and no task-specific model is set |
| `RUNNER_CLAUDE_MODEL_MINIMAL` / `LOW` / `MEDIUM` / `HIGH` | `RUNNER_CLAUDE_MODEL` | Optional model selected for the matching reasoning effort when `RUNNER=claude` |
| `CORE_AUTO_UPDATE` | true | Check and pull the shared-core subtree immediately before each cycle; `false` skips the check entirely |
| `INTEGRATION_BRANCH` | empty | Empty keeps the direct single-worktree layout; a branch name freezes the daemon checkout and makes this separate branch the task base, merge target, gate target, and PR source |
| `UPSTREAM_REMOTE` | package `upstreamRepo` | Remote name, Git URL/path, or GitHub `owner/repository` to fetch and subtree-pull |
| `UPSTREAM_REPO` | package `upstreamRepo` | Environment-only override for the GitHub `owner/repository` where `report-upstream` files the report |
| `UPSTREAM_BRANCH` | main | Shared-core branch to compare and pull |

## Shared backlog and workers

With `ISSUE_QUEUE_ENABLED=true` the backlog moves to forge issues: findings are filed once
per fingerprint, workers claim by self-assignment, quiet claims are reaped after a lease,
and merged work stays open until promotion reaches the default branch and closes the issue.
Ready titles naming the same primary file are claimed in groups of up to four; no-path titles
remain singletons, and failed groups retry as individual findings. Each grouped requirement
needs its own completion marker before the branch can merge; promotion then closes every
linked issue. When investigation proves an ordinary task needs no implementation, an exact
`NO_CHANGE_WARRANTED` final-message marker terminalizes its clean, commit-free task and closes
the linked issue directly instead of entering merge retries. A second machine runs execution-only with
`worker <base-ref>` — it claims and executes, pushes finished branches, and never scans,
reviews, or merges. Exactly one ordinary daemon owns the branch and adopts those pushes.

A failed task returns its issue to `loop:ready` until that issue reaches
`MAX_ISSUE_RETRIES` consecutive failures. The bound defaults to 3; at the bound the issue is
parked as `loop:retry-exhausted` and the loop records a `Parked` event instead of claiming it
again, then stops for operator repair. A successful task completion clears the issue's
persisted failure count.

Concurrent workers must authenticate as **distinct forge accounts**; the login is the
worker identity, and two daemons sharing one account are indistinguishable to the claim.

## Status

Extracted from a working project, where it has shipped fifteen unattended runs. The
behaviour checklist in `SPEC.md` is the specification; the vitest suite pins it. Treat the
API as unstable — this is shared source, not a versioned library.

## License

MIT
