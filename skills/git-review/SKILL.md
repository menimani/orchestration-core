---
name: git-review
description: Reviews a pull request diff and submits the result as a GitHub review. Use when asked to review a PR, including one you opened yourself.
argument-hint: "<pr-number>"
allowed-tools: Bash, Read
---

# Pull Request Review

Review PR code changes and submit approval or feedback.

## PR Context

**PR details:**
!`gh pr view $ARGUMENTS --json number,title,author,state,additions,deletions,changedFiles`

**Current user:**
!`gh api user --jq .login`

**Changed files:**
!`gh pr diff $ARGUMENTS --name-only`

## Self-PR Handling

GitHub does not allow self-approval. For self-PRs:
- Perform full review analysis
- Submit as **comment** (`gh pr review <number> --comment`) instead of approval
- Include "Verdict: APPROVED (self-review)" in comment

## Review Process

1. Read the full diff: `gh pr diff <number>`
2. Analyze each changed file for bugs, security issues, convention violations
3. Submit review with appropriate action (`--approve`, `--comment`, or `--request-changes`)

## Output

```
## Verification
- PR: #<number> reviewed
- files: [count] files analyzed
- result: [APPROVED/COMMENTED/CHANGES_REQUESTED]
- issues: [count] issues found (if any)
```
