## Known pitfalls — check your diff against every line before committing

<!-- Curation: at most 20 entries. A pattern earns a line only after reviews flagged it
     twice. At the cap, drop the lowest-impact entry to admit a new one; if a dropped
     pattern recurs, restore its line and let the list exceed the cap. -->

- SPEC.md is the contract, not a summary: a behaviour change lands with the specification item that describes it, in the same commit.
- README.md is what a consumer reads before adopting the package. A command, variable, or path named there must exist exactly as written.
- Do not duplicate what the source already states. A listing of commands or environment variables drifts by construction; point at the code or generate it.
- Comments earn their place by naming a constraint or an incident the code cannot show. A comment that restates the next line is deletable.
- Write in English throughout, including commit messages and issue text.
- When documenting a workaround, say what forced it — a platform limitation, a tool's behaviour — so a later reader can tell when it stops being necessary.
