import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RebaseConflict } from './merge.ts'
import type { OrchPaths } from './paths.ts'

/**
 * A completed attempt whose pre-merge rebase conflicted: where its commits are kept and
 * what they collided with. A retry starts from these commits instead of from nothing.
 */
export interface ConflictedAttempt extends RebaseConflict {
  taskId: string
  /** The branch that keeps the attempt's commits until a later attempt merges. */
  branch: string
}

/**
 * Attempts are recorded per pending task (`<taskId>.json`) or, while their issue waits to
 * be claimed again, per issue (`issue-<number>.json`). Each record lists every conflicted
 * attempt in the chain, oldest first, so one merge can remove all of their branches.
 */
function recordFile(paths: OrchPaths, key: string): string {
  return join(paths.queueDir, 'conflict-retry', `${key}.json`)
}

export function issueConflictKey(issueNumber: number): string {
  return `issue-${issueNumber}`
}

// A chain of conflicted attempts is retried from its kept commits at most this many
// times. Each retry races the same sibling merges, so a third conflict is left for a person.
const MAX_CONFLICT_RETRIES = 2

/** Whether a chain of conflicted attempts has used every retry it is allowed. */
export function conflictRetriesExhausted(attempts: readonly ConflictedAttempt[]): boolean {
  return attempts.length > MAX_CONFLICT_RETRIES
}

const STRING_FIELDS = ['taskId', 'branch', 'runBranch', 'runTip', 'base', 'taskTip'] as const

function isAttempt(value: unknown): value is ConflictedAttempt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return STRING_FIELDS.every((field) => typeof record[field] === 'string' && record[field] !== '')
    && Array.isArray(record.conflictedFiles)
    && record.conflictedFiles.every((file) => typeof file === 'string')
    && Array.isArray(record.conflictingCommits)
    && record.conflictingCommits.every((commit) => typeof commit === 'string')
}

/** The conflicted attempts behind `key`, oldest first; empty when there are none. */
export function readConflictedAttempts(paths: OrchPaths, key: string): ConflictedAttempt[] {
  const file = recordFile(paths, key)
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Malformed conflict retry record ${file}; repair or remove it`, { cause: error })
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isAttempt)) {
    throw new Error(`Malformed conflict retry record ${file}; repair or remove it`)
  }
  return parsed
}

export function writeConflictedAttempts(
  paths: OrchPaths,
  key: string,
  attempts: readonly ConflictedAttempt[],
): void {
  const file = recordFile(paths, key)
  mkdirSync(join(paths.queueDir, 'conflict-retry'), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(attempts, null, 2)}\n`, { flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function removeConflictedAttempts(paths: OrchPaths, key: string): void {
  rmSync(recordFile(paths, key), { force: true })
}

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || 'unknown error'
}

// Exit 1 is the only answer that means "absent". Any other failure is rethrown, because
// reading it as absent would drop the record of a branch that is still there.
function localBranchPresent(repoRoot: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    return true
  } catch (error) {
    if ((error as { status?: number | null }).status === 1) return false
    throw error
  }
}

/**
 * Once a retry lands, the commits kept for it are history: drop their branches. A record
 * is removed only once every branch it names is confirmed gone, so a branch that could
 * not be removed stays recorded and is reported rather than orphaned. Returns one line
 * per failure; empty when everything kept for the task is gone.
 */
export function retireConflictedAttempts(
  paths: OrchPaths,
  taskId: string,
  linkedIssues: readonly number[],
): string[] {
  const failures: string[] = []
  try {
    const records = [taskId, ...linkedIssues.map(issueConflictKey)].map((key) => ({
      key, branches: readConflictedAttempts(paths, key).map(({ branch }) => branch),
    }))
    const remaining = new Set<string>()
    for (const branch of new Set(records.flatMap(({ branches }) => branches))) {
      try {
        if (localBranchPresent(paths.repoRoot, branch)) {
          execFileSync('git', ['branch', '-D', branch], {
            cwd: paths.repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          })
        }
        if (localBranchPresent(paths.repoRoot, branch)) throw new Error('branch is still present after deletion')
      } catch (error) {
        remaining.add(branch)
        failures.push(`${branch}: ${failureText(error)}`)
      }
    }
    for (const { key, branches } of records) {
      if (branches.every((branch) => !remaining.has(branch))) removeConflictedAttempts(paths, key)
    }
  } catch (error) {
    failures.push(failureText(error))
  }
  return failures
}

/**
 * The specification section that hands the latest conflicted attempt to a retry. Its
 * branch already carries any earlier attempt's work, so only the latest is named. File
 * paths and commit hashes come from Git; commit subjects are left out because they are
 * repository-controlled text, and the runner can read them with `git show`.
 */
export function conflictRetrySection(attempts: readonly ConflictedAttempt[]): string {
  const attempt = attempts.at(-1)
  if (attempt === undefined) return ''
  const lines = [
    '',
    '## Rebase conflict from an earlier attempt',
    '',
    `An earlier attempt at this task, \`${attempt.taskId}\`, completed, but its commits could not`
    + ` be rebased onto \`${attempt.runBranch}\` at \`${attempt.runTip}\`, because later commits on`
    + ` that branch changed the same files. Its commits are kept on branch \`${attempt.branch}\`,`
    + ` which forked from \`${attempt.base}\`.`,
  ]
  if (attempt.conflictedFiles.length > 0) {
    lines.push('', 'Files that conflicted:', '')
    for (const file of attempt.conflictedFiles) lines.push(`- \`${file}\``)
  }
  if (attempt.conflictingCommits.length > 0) {
    lines.push(
      '',
      `Commits on \`${attempt.runBranch}\` after the fork point that changed those files`
      + ' (read them with `git show`):',
      '',
    )
    for (const commit of attempt.conflictingCommits) lines.push(`- \`${commit}\``)
  }
  lines.push(
    '',
    `Begin by applying that attempt to this worktree with \`git cherry-pick ${attempt.base}..${attempt.branch}\`.`
    + ' Resolve every conflict so that both the run branch\'s changes and this task\'s'
    + ' requirement hold; never discard the run branch\'s changes to make a conflict'
    + ' disappear. Complete the cherry-pick, finish whatever the requirement still needs,'
    + ' run the checks this specification names, and finish as it describes.',
    '',
  )
  return lines.join('\n')
}
