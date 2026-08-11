## Known pitfalls — check your diff against every line before committing

<!-- Curation: at most 20 entries. A pattern earns a line only after reviews flagged it
     twice. At the cap, drop the lowest-impact entry to admit a new one; if a dropped
     pattern recurs, restore its line and let the list exceed the cap. -->

- The suite runs on Windows and on Linux CI. A fixture that touches the real filesystem must work on both: strip extended-length markers and convert separators inside the fixture, never assume the host the author used.
- A fixture that declares a platform must behave like that platform all the way down, or the test proves nothing about the path it claims to cover.
- Assert exact strings and exact call arguments; "was called" locks nothing down, and the log format is a contract worth pinning line by line.
- Pin every environment variable the assertion depends on. A test that inherits MAX_SCAN_CYCLES from a running daemon passes on the author's machine and fails in CI.
- Reset mock implementations per test — clearAllMocks keeps implementations, so a predecessor's rejection leaks into the next test.
- Tests that drive real git repositories need their own temporary directory and must remove it afterwards; the suite runs single-threaded because these fixtures raced.
- Assert the failure paths, not only the success: what the loop does when a merge fails, when the forge is unreachable, when a claim has no local task.
- A test that cannot fail is worse than no test: if deleting the implementation leaves it green, it is describing nothing.
