## Known pitfalls — check your diff against every line before committing

<!-- Curation: at most 20 entries. A pattern earns a line only after reviews flagged it
     twice. At the cap, drop the lowest-impact entry to admit a new one; if a dropped
     pattern recurs, restore its line and let the list exceed the cap. -->

- Paths: never assume a separator. Windows hosts produce backslashes and extended-length prefixes; POSIX hosts do not. Build paths with node:path and convert only where a platform demands it.
- Long Windows paths defeat plain removal: keep the extended-length fallback and report honestly which attempt succeeded.
- Never inherit a child process's stdio into the daemon log. Capture it, route it to the task's own log, and surface only a summarized line.
- Forge calls are the scarce resource: one listing per poll, cached verdicts keyed by updatedAt, and a rate-limit error means waiting until the reported reset, not retrying every poll.
- A step that cannot verify its own effect must not report success — a merge, a push, and a deploy are each judged by what the target holds afterwards, not by the command's exit code.
- Fail closed at the gate: when the loop cannot tell whether remote work is outstanding, it waits rather than promoting.
- Never leave a claim nobody is executing. A startup failure releases the issue in the same poll that discovered it.
- Frozen output tokens (CYCLE_COMPLETE, LOOP_DONE, FAILED, NEXT_TASK, DECISION_REQUIRED, NO_CHANGE_WARRANTED, TASK_COMPLETE) are a contract with skills and consumers; changing their spelling breaks callers you cannot see.
- Every line the daemon writes goes through the log helper, in the aligned event format, capped and timestamped. A raw console write is a bug.
- Keep repository specifics out of the core: a command, a path, or a filename that belongs to one project belongs in that project's adapter.
- The daemon holds the code it started with. A fix only takes effect after a restart — never report it as active before that.
