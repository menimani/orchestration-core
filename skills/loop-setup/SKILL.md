---
name: loop-setup
description: Adopts the shared orchestration core in a repository and verifies the result. Use when installing this core for the first time, repairing its scaffold or hooks, or completing a repository's project adapter.
---

# Set up the loop

Treat the subtree import as a deliberate user action. If `orchestration/ts/package.json`
does not exist, show this command and pause until the user runs it:

```bash
git subtree add --prefix=orchestration/ts https://github.com/menimani/orchestration-core.git main --squash
```

Do not run `git subtree add` on the user's behalf.

## Collect repository decisions

Read the contributor guidance and manifests, then confirm with the user:

- the project name;
- fast staged-path checks for `preCommitChecks`;
- full and light `mergeChecks`, including each check's path predicate;
- the cycle suite;
- pull-request categories, path classification, and risk signals;
- optional CI, scan-worktree, Docker, infrastructure, and deployment declarations.

Use repository-relative paths and commands the repository already documents. Do not
invent a gate from a tool merely being present.

## Initialize and write the adapter

Run:

```bash
npm ci --prefix orchestration/ts
node orchestration/ts/src/cli.ts init <project-name>
```

Record every `CREATED`, `EXISTS`, `DIVERGED`, `PASS`, and `FAIL` line. Init never
overwrites an existing project-owned file or a different `core.hooksPath` value.

Edit the generated `orchestration/project/project-<name>.ts` from the decisions above
only when init created it in this run. If an adapter already existed, report it and ask
before changing it; deliberate divergence is not a repair target.

Keep `preCommitChecks` fast. The core-owned hook supplies the default-branch guard and
selects these checks from staged paths. Do not create repository-owned hook scripts.

## Verify

Run:

```bash
node orchestration/ts/src/cli.ts verify-setup
```

Report each check exactly as `PASS`, `FAIL`, or `SKIP` with its reason. The verifier
checks the core TypeScript compilation, the adapter's cycle suite, real `loadProject`
discovery by name, every adapter-referenced path, the current branch's pushable upstream,
`core.hooksPath`, and all `loop:*` labels. Never summarize a skipped check as passed.

Do not declare setup complete while any check says `FAIL`. Do not create or change a
remote/upstream merely to clear that failure without the user's approval.
