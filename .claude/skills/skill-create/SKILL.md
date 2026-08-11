---
name: skill-create
description: Writes and revises the skills in this repository against Anthropic's authoring guidance. Use when creating a skill, or when an existing skill's frontmatter, description, or structure needs reviewing.
disable-model-invocation: true
allowed-tools: Read, Write, Glob, Grep
---

# Creating a skill

Existing skills:

!`ls .claude/skills/`

Skills live in `.claude/skills/<name>/SKILL.md`. Only the frontmatter is preloaded at
startup; the body is read when the skill is selected, and supporting files only when the
body links to them. That is the whole reason to put something in a skill rather than in
`CLAUDE.md` — the latter is paid for in every session.

## Frontmatter

`name` — lowercase letters, digits and hyphens, 64 characters at most. Never `anthropic`
or `claude`, and never a placeholder like `helper`, `utils`, or `tools`.

Name it **subject first, then what you do to it**: `git-pr`, `loop-start`, `skill-create`.
Everything sharing a subject then sorts together, which is how you find a skill you half
remember. Reversing it to `start-loop` reads more naturally in isolation and scatters the
family, so the collection loses more than the single name gains.

The exception is a skill whose subject is the action — `verify-changes` has no noun to
put first, and `changes-verify` would name a report rather than something you run. Reach
for it only when the subject-first form genuinely has nothing to put in front.

`description` — third person, giving both what the skill does and when to reach for it.
This is the field that selects the skill, so it earns more care than anything in the body.

```yaml
description: Reviews a pull request's diff and submits the result as a GitHub review.
  Use when asked to review a PR, including one you opened yourself.
```

`Review pull requests` fails on both counts — imperative, and silent about when. `I can
review PRs` fails differently: first person reads inconsistently once it has been
injected into the system prompt.

Optional: `argument-hint` when the body uses `$ARGUMENTS`, `allowed-tools` to narrow what
the skill may do, and `disable-model-invocation: true` for skills that should only ever
run because a person asked.

## Body

Under 500 lines, and written for a reader who is already competent. Cut anything that
explains a language, a library, or a familiar workflow. Keep what is specific to this
repository and would otherwise be guessed wrong.

Match how prescriptive you are to what a wrong choice costs. Reviewing code tolerates
judgement and should be described in general terms. A migration or a merge does not —
name the exact command and say what must not be varied.

Link supporting files directly from SKILL.md, never file to file: a reference reached
through another reference tends to be read only in part. Give any file over 100 lines a
contents list at the top, for the same reason.

## Dynamic context

`!` followed by a backtick-wrapped command injects that command's output into the prompt
before the skill runs. The rules are narrow and fail quietly — see
[reference.md](reference.md).

## Before finishing

- Does the description say *when*, not only *what*?
- Is any of this already in `CLAUDE.md`? A rule that must hold whoever is acting — Codex
  included, and it cannot invoke skills — belongs there. A procedure for a task someone
  explicitly starts belongs here.
- Will it still be true after the next refactor, or does it name paths that move?
- Forward slashes in every path, including on Windows.
