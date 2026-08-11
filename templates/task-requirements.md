## Before reporting this done

Read the repository's contributor guidance and use its documented commands. Run every
test, build, lint, formatting, or generated-file check that applies to the changed paths;
do not substitute a narrower command unless it exercises the same gate.

Add or update tests when behaviour changes. Reproduce a reported failure before changing
the implementation, then run the same reproduction after the fix as well as the relevant
full suite. Do not weaken assertions, widen timeouts, or disable checks merely to make a
failure disappear.

Review the final diff for unintended changes and repository-specific invariants that
automated checks may not cover. Report the commands you ran and any checks you could not
run.
