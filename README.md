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
  Codex runner uses it to launch the Codex CLI safely
- An agent CLI (the bundled runner adapter drives [Codex](https://openai.com/codex/))
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

Immediately before each cycle starts, the daemon fetches the configured shared-core
upstream and compares it with the last import of this package's subtree. If the subtree
is behind, it runs `git subtree pull --squash`; when package files change, it replaces
itself from the package's absolute CLI path so the new cycle uses the pulled code while
retaining the arguments, environment, and run branch. The parent reports success only
after the replacement daemon finishes startup. This happens only after the prior gate
has closed and while no task is running.
A daemon otherwise runs the code it started with. A dirty working tree or conflicting
pull is left for the consumer to resolve: the daemon warns and starts the cycle on the
old code instead of merging local divergence.

That same boundary syncs the skills declared in `skills/manifest.json` into every
directory an agent working in the repository reads them from. The selected runner adapter
supplies one — the bundled Codex adapter uses `.agents/skills/` and rewrites the sources
into Codex's own form — and `.claude/skills/` receives them for the interactive agent a
person drives, in the canonical form that agent already speaks. Serving only the runner
meant that selecting Codex silently took every shared workflow away from the person, so
one destination failing no longer costs the others theirs. Loop commands are rendered for
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
| forge   | `FORGE`  | `github`             | `forge-github` (`gh`)  | move to Gitea, GitLab, … |
| runner  | `RUNNER` | `codex`              | `runner-codex`         | drive a different agent CLI |
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

A project adapter answers a few questions: which staged-path checks run before a commit,
which commands gate a merge, which tests a changed path implies, which suites run once per
cycle, how commits are grouped in the generated pull request, which changed paths signal
risk, and how a deployment is verified. The core supplies commit subjects, changed and
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

Use the repository's `loop-setup` skill to collect the project-specific decisions, fill
the generated adapter, and run `verify-setup`. The verifier reports the TypeScript gate,
adapter suite, real adapter discovery, referenced paths, pushable branch upstream, hooks
setting, and labels separately; skipped checks retain their reason.

Then start a run on a topic branch — never on your default branch, because the loop
commits and merges on its own. On POSIX shells:

```bash
MAX_SCAN_CYCLES=12 MAX_PARALLEL=8 AUTO_REVIEW=true \
  node orchestration/ts/src/cli.ts loop --daemon
```

On Windows PowerShell (with `bash` on `PATH` as described above):

```powershell
$env:MAX_SCAN_CYCLES = '12'
$env:MAX_PARALLEL = '8'
$env:AUTO_REVIEW = 'true'
node orchestration/ts/src/cli.ts loop --daemon
```

`node orchestration/ts/src/cli.ts` with no arguments lists every command: `init` repairs
the adoption scaffold, `verify-setup` checks it, `delegate` hands a decision from your own
head to the loop, `loop-status` says what is in flight, `ci-wait` waits on a pull request's
checks without believing a partial rollup, and `deploy` dispatches a deployment workflow
and verifies the revision that actually came up.

Automatic pulls are enabled by default. To pull later improvements manually, or when
`CORE_AUTO_UPDATE=false` pins the consumed version, use:

```bash
git subtree pull --prefix=orchestration/ts \
  https://github.com/menimani/orchestration-core.git main --squash
```

## Settings worth knowing

| Variable | Default | Effect |
|----------|---------|--------|
| `MAX_SCAN_CYCLES` | 3 | Scan-and-fix rounds before the pull request is promoted |
| `MAX_PARALLEL` | 3 | Agent processes at once |
| `TASK_GATE` | full | `light` uses project-adapter-selected reduced checks for each merge, followed by the adapter's cycle suite once per cycle |
| `AUTO_REVIEW` | false | Enable agent review of cycle diffs and queue the findings as fixes |
| `REVIEW_EVERY_N_CYCLES` | 1 | With `AUTO_REVIEW=true`, review every Nth cycle and always review the final cycle |
| `CI_GATE_ENABLED` | false | Enable polling PR checks and queueing CI-fix tasks; when false, the CI gate is skipped |
| `ISSUE_QUEUE_ENABLED` | false | Keep the backlog in forge issues so several machines can share it |
| `SCAN_EFFORT` / `TASK_EFFORT` / `REVIEW_EFFORT` | high / medium / high | Reasoning effort per kind of work |
| `CORE_AUTO_UPDATE` | true | Check and pull the shared-core subtree immediately before each cycle; `false` skips the check entirely |
| `UPSTREAM_REMOTE` | package `upstreamRepo` | Remote name, Git URL/path, or GitHub `owner/repository` to fetch and subtree-pull |
| `UPSTREAM_BRANCH` | main | Shared-core branch to compare and pull |

## Shared backlog and workers

With `ISSUE_QUEUE_ENABLED=true` the backlog moves to forge issues: findings are filed once
per fingerprint, workers claim by self-assignment, quiet claims are reaped after a lease,
and the merge commit closes the issue. Ready titles naming the same primary file are claimed
in groups of up to four; no-path titles remain singletons, and failed groups retry as
individual findings. Each grouped requirement needs its own completion marker before the
branch can merge and close every linked issue. A second machine runs execution-only with
`worker <base-ref>` — it claims and executes, pushes finished branches, and never scans,
reviews, or merges. Exactly one ordinary daemon owns the branch and adopts those pushes.

Concurrent workers must authenticate as **distinct forge accounts**; the login is the
worker identity, and two daemons sharing one account are indistinguishable to the claim.

## Status

Extracted from a working project, where it has shipped fifteen unattended runs. The
behaviour checklist in `SPEC.md` is the specification; the vitest suite pins it. Treat the
API as unstable — this is shared source, not a versioned library.

## License

MIT
