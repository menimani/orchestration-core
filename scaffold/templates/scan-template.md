# {{SCAN_ID}}

## Purpose

Investigate this repository and report concrete improvements as NEXT_TASK. Do not change
files during this scan.

{{SCAN_SCOPE}}

## Accepted limits

These are accepted limits by decision. Do not report them or propose narrower variants
of them as findings. A finding qualitatively beyond an entry is still reportable.

{{ACCEPTED_LIMITS}}

## Method

Read the repository's contributor guidance, run its documented checks, and inspect the
code, tests, documentation, portability, and failure handling. Verify each finding before
reporting it.

Report each finding on one line:

`NEXT_TASK: [category] specific description -> fix approach`

If there are no findings, print `NO_FINDINGS` on its own line. Finish with
`TASK_COMPLETE` on its own line.
