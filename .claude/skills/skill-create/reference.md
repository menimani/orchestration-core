# Dynamic context reference

## Contents

- Bang-backtick rules and why each one exists
- Patterns that work, and the failures they replace
- `$ARGUMENTS` handling
- Frontmatter fields beyond `name` and `description`

## Dynamic Context (bang-backtick)

The bang-backtick syntax (`!` followed by a backtick-wrapped command) injects live data into the skill prompt before Claude sees it. The command runs during skill expansion.

### CRITICAL RULES

| Rule | Reason |
|------|--------|
| Single command only | Compound commands (&&, \|\|, pipes) cause permission failures |
| No 2>/dev/null | Part of a compound expression, gets blocked |
| No pipe to head/tail/grep | Pipe = compound command |
| No if/for/while | Shell control flow = compound command |
| No find with pipes | Usually require pipes or redirects |
| Command must succeed | Non-zero exit = skill expansion failure |

### Safe Examples

These patterns work correctly:

```
git status --short
git branch --show-current
git log main..HEAD --oneline
gh pr view $ARGUMENTS --json number,title,state
gh api user --jq .login
ls orchestration/templates/
```

Wrap each command with the bang-backtick syntax: exclamation mark, then the command inside backticks.

### Unsafe Examples (WILL FAIL)

These patterns will cause permission check failures:

```
git log --oneline | head -5                    # pipe
gh pr checks $ARGUMENTS 2>/dev/null            # redirect
cat file.json | jq .field                      # pipe
[ -f "file" ] && echo "yes" || echo "no"       # logic operators
find . -name "*.java" 2>/dev/null | wc -l      # pipe + redirect
if [ -f "file" ]; then cat file; fi            # control flow
```

### Alternative for Complex Data

Instead of complex bang-backtick commands:
- Use static text describing the project structure
- Instruct Claude to run the command itself in the Instructions section
- Use a wrapper script in the skill's `scripts/` directory

## String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed to skill |
| `$ARGUMENTS[N]` / `$N` | Nth argument (0-based) |
| `${CLAUDE_SESSION_ID}` | Current session ID |

## Frontmatter Reference

```yaml
---
name: kebab-case-name           # Required: becomes /slash-command
description: >-                  # Recommended: helps Claude decide when to use
  What this skill does and when.
  Be specific about triggers.
argument-hint: "<arg>"           # Optional: shown in autocomplete
disable-model-invocation: true   # Optional: user-only invocation
user-invocable: false            # Optional: Claude-only invocation
allowed-tools: Read, Grep, Glob  # Optional: tools without permission prompt
context: fork                    # Optional: run in isolated subagent
agent: Explore                   # Optional: agent type for context: fork
model: sonnet                    # Optional: model override
---
```

## Execution Context Details

| Context | When to use |
|---------|-------------|
| **inline** (default) | Needs conversation history, guidelines, conventions |
| **context: fork** | Isolated task, heavy processing, or long output |

### Fork Agents

| Agent | Use case |
|-------|----------|
| `Explore` | Read-only codebase research |
| `Plan` | Architecture and implementation planning |
| `general-purpose` (default) | Full tool access |

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
├── reference.md       # Detailed docs (loaded on demand)
├── examples.md        # Usage examples
├── templates/         # Templates Claude fills in
└── scripts/           # Scripts Claude executes
```
