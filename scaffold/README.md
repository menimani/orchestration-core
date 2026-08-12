# Orchestration

The shared core lives in `orchestration/ts`; the project adapter and templates beside it
belong to this repository.

After every fresh clone, install dependencies and restore the repository-local hook
setting:

```bash
npm ci --prefix orchestration/ts
node orchestration/ts/src/cli.ts init
```

The init command is safe to repeat. It reports existing project-owned files and leaves
them unchanged.
