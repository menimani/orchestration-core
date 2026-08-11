# orchestration-core

An autonomous improvement loop for a software repository. It scans the codebase, turns
what it finds into tasks, runs them through an agent CLI in isolated git worktrees, merges
what passes the repository's own tests, reviews the accumulated diff, and opens the pull
request — unattended, for as many cycles as you allow.

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
scan → tasks → run in worktrees → test → merge → cycle gate → … → review → promote
```

Each cycle scans the repository, queues what the scan reports, executes queued tasks in
parallel worktrees, and merges each one only after the tests selected for the paths it
touched pass against the branch tip. Cycles end at a gate that pushes and updates a draft
pull request. The final cycle is reviewed by an agent reading the whole branch diff; a
round that raises findings turns them into fix tasks and reads the corrected diff again.
The run ends by promoting the pull request, or by stopping for a person when its own
review will not converge.

Nothing here decides that shipping is safe. Deployment stays a human action.

## The three adapters

The core knows nothing about your forge, your agent CLI, or your repository. Three seams
carry all of that:

| Adapter | Selected by | Bundled implementation | Replace it to… |
|---------|-------------|------------------------|----------------|
| forge   | `FORGE`     | `forge-github` (`gh`)  | move to Gitea, GitLab, … |
| runner  | `RUNNER`    | `runner-codex`         | drive a different agent CLI |
| project | `PROJECT`   | none — you write it    | describe *your* repository |

The project adapter is the one you must supply. It lives **outside** this package so a
`git subtree pull` never touches it:

```
your-repo/
  orchestration/
    project/project-<name>.ts   ← yours: gate commands, path→test selection, cycle suites
    templates/                  ← yours: what a scan looks for in this repository
    ts/                         ← this package, pulled as a subtree
```

Point `PROJECT=<name>` at it, or give `PROJECT_ADAPTER` an explicit path.

A project adapter answers a few questions: which commands gate a merge, which tests a
changed path implies, which suites run once per cycle, and how a deployment is verified.

## Using it

```bash
git subtree add --prefix=orchestration/ts \
  https://github.com/menimani/orchestration-core.git main --squash
npm ci --prefix orchestration/ts
```

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

`node orchestration/ts/src/cli.ts` with no arguments lists every command: `delegate` hands
a decision from your own head to the loop, `loop-status` says what is in flight, `ci-wait`
waits on a pull request's checks without believing a partial rollup, `deploy` dispatches a
deployment workflow and verifies the revision that actually came up.

Pull later improvements with:

```bash
git subtree pull --prefix=orchestration/ts \
  https://github.com/menimani/orchestration-core.git main --squash
```

## Settings worth knowing

| Variable | Default | Effect |
|----------|---------|--------|
| `MAX_SCAN_CYCLES` | 3 | Scan-and-fix rounds before the pull request is promoted |
| `MAX_PARALLEL` | 3 | Agent processes at once |
| `TASK_GATE` | full | `light` gates each merge on build and lint, running full suites once per cycle |
| `AUTO_REVIEW` | false | Review each reviewed cycle's diff and queue the findings as fixes |
| `REVIEW_EVERY_N_CYCLES` | 1 | Review every Nth cycle; the final cycle is always reviewed |
| `ISSUE_QUEUE_ENABLED` | false | Keep the backlog in forge issues so several machines can share it |
| `SCAN_EFFORT` / `TASK_EFFORT` / `REVIEW_EFFORT` | high / medium / high | Reasoning effort per kind of work |

## Shared backlog and workers

With `ISSUE_QUEUE_ENABLED=true` the backlog moves to forge issues: findings are filed once
per fingerprint, workers claim by self-assignment, quiet claims are reaped after a lease,
and the merge commit closes the issue. A second machine runs execution-only with
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
