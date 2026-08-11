# {{FIX_ID}}: Fix CI failures (scan cycle {{CYCLE}})

## Purpose
CI is failing. Find why and fix it.

## PR
{{PR_URL}}

## Failure check (overview)
```
{{FAIL_SUMMARY}}
```

## Procedure
1. Read the failing job's log. Reproduce with the command CI itself ran — for the frontend
   that is `npm run test`, which measures coverage; `npm run test:only` skips the per-file
   thresholds and will tell you a coverage failure has gone away when it has not.
2. Work out the cause from the error, and say what it is before changing anything.
3. **Reproduce the failure locally first.** A test that fails only in CI usually fails on
   timing, load or zone rather than on anything the diff shows, and a run that passes on
   your machine is not evidence it is fixed — it is the state it was already in. Force the
   condition: delay the mock the test waits on, run under a different `TZ` or
   `-Duser.timezone`, run the file alone and run it with the full suite. If you cannot
   make it fail, say so and describe what you tried rather than claiming a fix.
4. Fix it, then show the same reproduction now passes.
5. **Look for the same shape elsewhere.** The failure names one test because one test ran
   first, not because it is the only one. Search the file and its neighbours for the same
   pattern and fix those too, or state that you checked and there were none.

## Constraints
- Do not weaken an assertion, widen a timeout or add a bare sleep to make a test pass. A
  flaky test is worse than a missing one because it teaches people to re-run rather than
  read.
- Do not disable or delete a failing test to clear the gate. If a test is wrong, say why.
- English only, as with everything outside the translation files.

## Completion criteria
- Every test that was failing now passes, and the build succeeds.
- The report states how you reproduced the failure, and what the same-shape search found.

TASK_COMPLETE
