import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readConflictedAttempts, writeConflictedAttempts } from '../src/conflictRetry.ts'
import { readGateFixState, writeGateFixState } from '../src/gateFix.ts'
import { recordIssuesForTask } from '../src/issueQueue.ts'
import { branchName, finalMessageFile, orchPaths, worktreeDir } from '../src/paths.ts'
import { processMarker, processMarkerText } from '../src/processMarker.ts'
import { readTaskState, writeStatus } from '../src/status.ts'
import { CLI, CLI_TIMEOUT_MS, CORE_ENV, git, repoRoot } from './cliHarness.ts'
import { TestProcessRegistry } from './testProcess.ts'

const testProcesses = new TestProcessRegistry()

afterEach(async () => {
  await testProcesses.cleanup()
})

describe('manual task commands', () => {
  function runCli(args: string[], input?: string) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: repoRoot,
      env: CORE_ENV,
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })
  }

  it.each([
    ['new', 'Usage: new <task-id>'],
    ['enqueue', 'Usage: enqueue <task-id> [depth]'],
    ['start', 'Usage: start <task-id> [--effort minimal|low|medium|high] [--model <model>]'],
    ['logs', 'Usage: logs <task-id> [-f]'],
    ['merge', 'Usage: merge <task-id> [--yes] [--test-cmd "cmd"]'],
  ])('prints the usage of %s and fails without a task id', (command, usage) => {
    const result = runCli([command])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(usage + '\n')
  })

  it('creates a specification once and refuses to overwrite it', () => {
    const taskId = 'manual-new'
    const file = join(orchPaths(repoRoot).tasksDir, taskId + '.md')

    const created = runCli(['new', taskId])

    expect(created.status).toBe(0)
    expect(created.stdout).toBe(`Created: ${file}\n`)
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^# ${taskId}\n\n## Target Files\n`))

    writeFileSync(file, 'edited\n')
    const repeated = runCli(['new', taskId])

    expect(repeated.status).not.toBe(0)
    expect(repeated.stderr).toContain(`Task specification already exists: ${file}`)
    expect(readFileSync(file, 'utf8')).toBe('edited\n')
  })

  it('enqueues at depth 0 when the depth is not a non-negative integer', () => {
    const taskId = 'manual-enqueue'
    expect(runCli(['new', taskId]).status).toBe(0)

    const result = runCli(['enqueue', taskId, 'abc'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`Enqueued: ${taskId} (depth=0)\n`)
    expect(readFileSync(join(orchPaths(repoRoot).queueDir, 'backlog.txt'), 'utf8'))
      .toBe(`${taskId}:0\n`)
  })

  it('enqueues at the depth given', () => {
    const taskId = 'manual-enqueue-depth'
    expect(runCli(['new', taskId]).status).toBe(0)

    const result = runCli(['enqueue', taskId, '2'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`Enqueued: ${taskId} (depth=2)\n`)
    expect(readFileSync(join(orchPaths(repoRoot).queueDir, 'backlog.txt'), 'utf8'))
      .toBe(`${taskId}:2\n`)
  })

  it('rejects an unknown start option before creating a worktree', () => {
    const taskId = 'manual-start-option'
    expect(runCli(['new', taskId]).status).toBe(0)

    const result = runCli(['start', taskId, '--fast'])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Error: unknown option: --fast\n')
    expect(existsSync(worktreeDir(orchPaths(repoRoot), taskId))).toBe(false)
  })

  it.each([['extreme'], [undefined]])('rejects the start effort %j before creating a worktree', (effort) => {
    const taskId = 'manual-start-effort'
    expect(runCli(['new', taskId]).status).toBe(0)

    const result = runCli(['start', taskId, '--effort', ...(effort === undefined ? [] : [effort])])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Error: --effort must be minimal, low, medium or high\n')
    expect(existsSync(worktreeDir(orchPaths(repoRoot), taskId))).toBe(false)
  })

  it('fails the status of a task without a status record', () => {
    const result = runCli(['status', 'manual-unknown'])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Task not found: manual-unknown\n')
  })

  // A graceful stop leaves exactly this state; the next daemon, not status, classifies it.
  it('leaves a running task without a process record running while no loop runs', async () => {
    const paths = orchPaths(repoRoot)
    await writeStatus(paths, 'stopped-in-flight', 'running')

    const result = runCli(['status'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${'stopped-in-flight'.padEnd(20)} ${'running'.padEnd(10)} pid=\n`)
    expect(runCli(['status', 'stopped-in-flight']).stdout).toContain('running')
  })

  it('fails a running task without a process record while a loop runs', async () => {
    const paths = orchPaths(repoRoot)
    await writeStatus(paths, 'dead-in-flight', 'running')
    writeFileSync(join(paths.queueDir, 'loop.pid'), processMarkerText(processMarker(process.pid)))

    const result = runCli(['status', 'dead-in-flight'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${'dead-in-flight'.padEnd(20)} ${'failed'.padEnd(10)} pid=\n`)
  })

  it('reports that there are no tasks when none has a status record', () => {
    const result = runCli(['status'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('There are no running or completed tasks.\n')
  })

  it('prints an empty backlog followed by the status listing', () => {
    const result = runCli(['queue'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe([
      '=== Queue (backlog) ===',
      '  (empty)',
      '',
      '=== Task Status ===',
      'There are no running or completed tasks.',
      '',
    ].join('\n'))
  })

  it('prints each backlog entry with its depth', () => {
    const queueDir = orchPaths(repoRoot).queueDir
    mkdirSync(queueDir, { recursive: true })
    writeFileSync(join(queueDir, 'backlog.txt'), 'manual-first:0\nmanual-second:3\n')

    const result = runCli(['queue'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe([
      '=== Queue (backlog) ===',
      `  ${'manual-first'.padEnd(30)} depth=0`,
      `  ${'manual-second'.padEnd(30)} depth=3`,
      '',
      '=== Task Status ===',
      'There are no running or completed tasks.',
      '',
    ].join('\n'))
  })

  it('fails a missing log', () => {
    const log = join(orchPaths(repoRoot).logsDir, 'manual-no-log.log')

    const result = runCli(['logs', 'manual-no-log'])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`Log not found: ${log}\n`)
  })

  it.each(['n\n', '\n', 'yes\n'])('aborts a merge without --yes on the answer %j', (answer) => {
    const result = runCli(['merge', 'manual-merge-declined'], answer)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      'Merge task/manual-merge-declined into the current branch? [y/N] Aborted.\n',
    )
    expect(result.stderr).toBe('')
  })

  it.each(['y\n', 'Y\n'])('proceeds with a merge without --yes on the answer %j', (answer) => {
    const result = runCli(['merge', 'manual-merge-accepted'], answer)

    expect(result.stdout).toBe(
      'Merge task/manual-merge-accepted into the current branch? [y/N] Merging manual-merge-accepted\n',
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('Task not found: manual-merge-accepted\n')
  })

  it('rejects an unknown merge option before asking', () => {
    const result = runCli(['merge', 'manual-merge-option', '--force'], 'y\n')

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Unknown option: --force\n')
  })
})

describe('manual merge', () => {
  it('builds merge options that close the task-linked issue', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20260808_000000_001_user-linked-merge'
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(join(worktree, 'work.txt'), 'done\n')
    git(['add', '-A'], worktree)
    git(['commit', '-qm', 'fix: complete linked task'], worktree)
    await writeStatus(paths, taskId, 'completed')
    recordIssuesForTask(paths, taskId, [197])
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '3\n')
    const runBranch = git(['branch', '--show-current']).trim()

    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(git(['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration (closes #197)`,
    )
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    expect(JSON.parse(readFileSync(
      join(paths.queueDir, 'issue-promotion', '197.json'), 'utf8',
    ))).toEqual({
      taskId,
      issueNumber: 197,
      mergeCommit,
      runBranch,
    })
  })

  it('clears the cycle gate flags, gate fix state, and kept conflict commits a merge leaves behind', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20261112_190000_001_user-manual-bookkeeping'
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(join(worktree, 'work.txt'), 'done\n')
    git(['add', '-A'], worktree)
    git(['commit', '-qm', 'fix: complete bookkeeping task'], worktree)
    await writeStatus(paths, taskId, 'completed')
    const keptBranch = 'orchestration/conflict/kept-attempt'
    git(['branch', keptBranch])
    writeConflictedAttempts(paths, taskId, [{
      taskId: '20261112_180000_001_user-earlier-attempt',
      branch: keptBranch,
      runBranch: 'main', runTip: 'a', base: 'b', taskTip: 'c',
      conflictedFiles: ['work.txt'], conflictingCommits: [],
    }])
    writeGateFixState(paths, taskId, { attempts: 1, verificationFailed: true, pending: false })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '2\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-2'), '')
    writeFileSync(join(paths.queueDir, 'cycle-resume-2'), '')

    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-2'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'cycle-resume-2'))).toBe(false)
    expect(readGateFixState(paths, taskId)).toBeUndefined()
    expect(readConflictedAttempts(paths, taskId)).toEqual([])
    expect(git(['branch', '--list', keptBranch]).trim()).toBe('')
  })

  it('clears the cycle-complete flag and gate fix state for a no-change outcome', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20261112_190000_002_user-no-change-bookkeeping'
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFileSync(finalMessageFile(paths, taskId),
      'The requested behavior is already present.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    await writeStatus(paths, taskId, 'completed')
    writeGateFixState(paths, taskId, { attempts: 1, verificationFailed: true, pending: false })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '3\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-3'), '')
    writeFileSync(join(paths.queueDir, 'cycle-resume-3'), '')

    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-3'))).toBe(false)
    // As in the loop, a no-change outcome adds no commits the gate has not verified.
    expect(existsSync(join(paths.queueDir, 'cycle-resume-3'))).toBe(true)
    expect(readGateFixState(paths, taskId)).toBeUndefined()
  })

  it('keeps the cycle gate flags when an inspect task merges commits', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20261112_190000_003_user-inspect-bookkeeping'
    mkdirSync(join(paths.queueDir, 'inspect'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'inspect', taskId), '')
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(join(worktree, 'report.txt'), 'findings\n')
    git(['add', '-A'], worktree)
    git(['commit', '-qm', 'docs: record inspection findings'], worktree)
    await writeStatus(paths, taskId, 'completed')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-4'), '')
    writeFileSync(join(paths.queueDir, 'cycle-resume-4'), '')

    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(readTaskState(paths, taskId)).toBe('merged')
    expect(readFileSync(join(repoRoot, 'report.txt'), 'utf8')).toBe('findings\n')
    // An inspection task is not cycle work, so its merge leaves the cycle's gate as it was.
    expect(existsSync(join(paths.queueDir, 'cycle-complete-4'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-resume-4'))).toBe(true)
  })
})
