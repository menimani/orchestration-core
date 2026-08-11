# {{SCAN_ID}}

## Purpose

Investigate this repository and report improvements as NEXT_TASK. **No code changes**.

This repository is the orchestration core itself: the loop that runs this very scan. A
finding here changes how every consuming repository is driven, so prefer the boring,
provable defect over the interesting redesign.

{{SCAN_SCOPE}}

## Investigation procedure

Perform in the following order. Run the commands and read their output before judging.

### 1. Automatic checks

```bash
npx tsc --noEmit
```
```bash
npm test -- --pool=threads --poolOptions.threads.singleThread 2>&1 | tail -40
```

Any type error or failing test is a finding. A test that fails only sometimes is a finding
about the test, not a reason to rerun until it passes.

---

### 2. Behaviour against the specification

`SPEC.md` is the contract this package keeps. Read it against the code and report where
they disagree — a documented behaviour no code implements, an implemented behaviour the
specification never mentions, or a numbered item whose wording no longer matches what the
tests pin.

Report the direction of the fix: whether the specification or the code is the one that
moved.

---

### 3. Portability

The package runs on Windows and on Linux CI, and its consumers may sit on either. Look for
code and tests that assume one of them:

- Path separators, drive letters, extended-length prefixes, `/tmp`
- Line endings, shell quoting, commands that exist on only one platform
- Process handling: signals, `kill`, process trees
- Tests that pass on the developer's host because they touch the real filesystem

Two of these already reached CI as failures. Prefer a fixture that works everywhere over a
platform guard in the test.

---

### 4. Adapter boundaries

Three seams keep this package independent of any repository: `forge`, `runner`, `project`.
Report anything that leaks across them — a forge command outside the forge adapter, an
agent-CLI assumption in the loop, a repository-specific path, command, or filename
anywhere in `src/` outside the adapter interfaces.

The generic adapters (`forge-github`, `runner-codex`) may name their own tools; the loop
core may not.

---

### 5. Failure handling

This package's job is to keep running unattended and to stop safely when it cannot. Look
for paths that:

- Report success without verifying the effect (a merge that never checked the result)
- Fail silently, or log a warning where the loop then proceeds as if nothing happened
- Retry forever without a bound, or give up without recording why
- Leave state behind that a later poll reads as work in progress

State in the finding what the loop would do wrongly, not merely that the code looks fragile.

---

### 6. Tests worth having or deleting

```bash
npm test -- --pool=threads --poolOptions.threads.singleThread --coverage 2>&1 | tail -30
```

Report untested behaviour rather than uncovered lines: a state transition in the gate, a
branch in the issue queue's claim logic, an error path that decides whether the loop stops.
Report tests that assert an implementation detail rather than a behaviour, tests that
cannot fail, and duplicates.

---

### 7. Redundancy — keep only what is needed

Read the sources for material whose deletion loses nothing: comments that restate the
adjacent code or narrate history instead of naming a constraint, unused exports, dead
branches, and documentation that duplicates what the code states.

A deletion finding must name the evidence that nothing references the item — the search
performed. Comments that carry an incident or a constraint stay: they are why this package
behaves as it does.

---

### 8. Consumer-facing surface

`README.md` is what a new consumer reads. Check its claims against the code: the commands
it lists, the environment variables it documents, the adapter contract it describes, the
subtree instructions it gives. Report a mismatch as `[DOCS]` naming the claim and what the
source actually does.

---

## Output

After completing the investigation, output **actual issues only**, one line each:

`NEXT_TASK: [category] specific description → fix approach`

Categories: `BUG` / `TEST` / `DOCS` / `PORTABILITY` / `SECURITY`.

**Rules:**
- Report only what you determined to be a problem; no guesses
- Name the file and the symbol so the implementer needs no further context
- Up to 8 items, most important first
- No code changes
- Write findings in English

If you found nothing, print `NO_FINDINGS` on its own line and no NEXT_TASK lines.

### Findings that are not yours to act on

Where the finding is a choice rather than a defect — a dependency's major version, a change
to the adapter contract that every consumer would have to follow — report it as:

`DECISION_REQUIRED: what the choice is, what each way costs, and what you would need to know`

## Completion marker

Finally print the following on its own line:
TASK_COMPLETE
