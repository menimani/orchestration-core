# Skill host reference

## Contents

- Runtime context
- User arguments and explicit invocation
- Codex metadata

## Runtime context

Keep runtime context as ordinary instructions so the workflow works across hosts. Name
the command, say when to run it, and say how its output affects the next step.

### Preferred pattern

```markdown
Run `git status --short` and use its output to identify the changed files before staging.
```

This makes failures visible to the agent and lets it choose the appropriate recovery.
Do not use host-specific pre-execution expansion in a canonical shared skill; Codex
treats that syntax as inert Markdown.

## User arguments and explicit invocation

Codex receives arguments as part of the user's request; it does not expand an
`$ARGUMENTS` variable in `SKILL.md`. Describe the expected value in the instruction,
for example `Run \`gh pr view <pr-number> --json number,title,state\``.

Mention a Codex skill explicitly as `$skill-name`. `/skills` opens the selector; a
slash command named after the skill does not invoke it.

## Frontmatter

```yaml
---
name: kebab-case-name
description: >-
  What this skill does and when.
  Be specific about triggers.
---
```

Only `name` and `description` belong in Codex `SKILL.md` frontmatter.

## Codex metadata

Put Codex presentation and invocation policy in `agents/openai.yaml`:

```yaml
interface:
  display_name: "Human-facing name"
  short_description: "Short purpose"
  default_prompt: "Use $skill-name to perform the workflow."
policy:
  allow_implicit_invocation: false
```

Omit `policy` when implicit invocation is appropriate. Keep tool dependencies in this
file as well; do not put tool allowlists in `SKILL.md` frontmatter.

## Content Guidelines

| Guideline | Detail |
|-----------|--------|
| Keep SKILL.md under 500 lines | Move details to supporting files |
| Instructions should be actionable | Not just guidelines, but steps |
| Include output format | So results are consistent |
| Reference supporting files | `See [reference.md](reference.md) for details` |

## Supporting File Structure

```
my-skill/
├── SKILL.md           # Main instructions (required, <500 lines)
├── agents/
│   └── openai.yaml    # Optional Codex metadata and invocation policy
├── references/        # Detailed docs loaded on demand
├── assets/            # Templates and output resources
└── scripts/           # Deterministic executable helpers
```
