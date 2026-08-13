---
name: skill-create
description: Writes and revises repository skills against the Agent Skills format and runner-specific conventions. Use when creating a skill, or when an existing skill's frontmatter, description, or structure needs reviewing.
---

# Creating a skill

Existing skills:

Run `ls .agents/skills/` and use its output as context before continuing.

Skills live in `.agents/skills/<name>/SKILL.md`. Only the frontmatter is preloaded at
startup; the body is read when the skill is selected, and supporting files only when the
body links to them. That is the whole reason to put something in a skill rather than in
always-loaded repository guidance — the latter is paid for in every session.

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

Keep runner-specific presentation and invocation policy out of this frontmatter. For
Codex, put it in `agents/openai.yaml`; see [reference.md](reference.md).

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

## Runtime context

Do not depend on host-specific prompt expansion. Tell the agent to run the command it
needs as an ordinary workflow step. See [reference.md](reference.md).

## Before finishing

- Does the description say *when*, not only *what*?
- Is any of this already in the repository's always-loaded guidance? A rule that must
  hold whoever is acting belongs there. A procedure for a selected task belongs here.
- Will it still be true after the next refactor, or does it name paths that move?
- Forward slashes in every path, including on Windows.
