import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { pruneTasks } from '../src/prune.ts'

const fsMockState = vi.hoisted(() => ({ removalFailurePath: undefined as string | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    rmSync: vi.fn((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      if (fsMockState.removalFailurePath !== undefined
          && String(path).includes(fsMockState.removalFailurePath)) {
        throw new Error('simulated removal failure')
      }
      actual.rmSync(path, options)
    }),
  }
})

let repoRoot: string
let paths: OrchPaths

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot })
}

function makeTask(id: string, status: string, age: 'old' | 'new'): void {
  writeFileSync(join(paths.tasksDir, `${id}.md`), `# ${id}\n`)
  const statusPath = join(paths.statusDir, `${id}.json`)
  writeFileSync(statusPath, JSON.stringify({ task_id: id, status }))
  writeFileSync(join(paths.logsDir, `${id}.log`), 'log\n')
  writeFileSync(join(paths.logsDir, `${id}.merge.log`), 'merge log\n')
  mkdirSync(join(paths.queueDir, 'scanned'), { recursive: true })
  mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
  writeFileSync(join(paths.queueDir, 'scanned', id), '')
  writeFileSync(join(paths.queueDir, 'effort', id), '')
  if (age === 'old') {
    const past = (Date.now() - 30 * 24 * 3600 * 1000) / 1000
    utimesSync(statusPath, past, past)
  }
}

beforeEach(() => {
  fsMockState.removalFailurePath = undefined
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-prune-'))
  paths = orchPaths(repoRoot)
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('pruneTasks', () => {
  const OLD_MERGED = '20250101_000000_001_user-old-merged'
  const OLD_NO_CHANGE = '20250101_000000_005_user-old-no-change'
  const OLD_FAILED = '20250101_000000_004_user-old-failed'

  function setUpFixtures(): void {
    makeTask(OLD_MERGED, 'merged', 'old')
    makeTask(OLD_NO_CHANGE, 'no-change', 'old')
    mkdirSync(join(paths.queueDir, 'desc-index'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'desc-index', 'user-deadbeef'), `${OLD_MERGED}\n`)

    makeTask('20990101_000000_001_user-new-merged', 'merged', 'new')
    makeTask('20250101_000000_002_user-old-running', 'running', 'old')
    makeTask(OLD_FAILED, 'failed', 'old')
    writeFileSync(join(paths.queueDir, 'scanned', `${OLD_FAILED}.failed`), 'failure evidence\n')

    makeTask('20250101_000000_003_user-old-worktree', 'merged', 'old')
    mkdirSync(join(paths.worktreesDir, '20250101_000000_003_user-old-worktree'), { recursive: true })

    makeTask('manual-task', 'merged', 'old')
    git(['add', 'orchestration/tasks/manual-task.md'])
    git(['commit', '-qm', 'chore: add manual task spec'])

    const orphan = join(paths.logsDir, 'orphan-task.log')
    writeFileSync(orphan, 'orphan\n')
    const orphanFinal = join(paths.logsDir, 'orphan-task.final')
    writeFileSync(orphanFinal, 'final message\n')
    const loopLog = join(paths.logsDir, 'loop.log')
    writeFileSync(loopLog, 'loop\n')
    const past = (Date.now() - 30 * 24 * 3600 * 1000) / 1000
    utimesSync(orphan, past, past)
    utimesSync(orphanFinal, past, past)
    utimesSync(loopLog, past, past)
  }

  it('deletes nothing on a dry run', () => {
    setUpFixtures()
    const report = pruneTasks(paths, { days: 14, dryRun: true })
    expect(report.removed.length).toBeGreaterThan(0)
    expect(existsSync(join(paths.statusDir, `${OLD_MERGED}.json`))).toBe(true)
  })

  it('aborts without deleting artifacts when tracked-spec discovery fails', () => {
    makeTask(OLD_MERGED, 'merged', 'old')
    rmSync(join(repoRoot, '.git'), { recursive: true, force: true })

    expect(() => pruneTasks(paths, { days: 14, dryRun: false }))
      .toThrow('Failed to discover tracked task specifications; pruning aborted')

    for (const retained of [
      join(paths.statusDir, `${OLD_MERGED}.json`),
      join(paths.logsDir, `${OLD_MERGED}.log`),
      join(paths.logsDir, `${OLD_MERGED}.merge.log`),
      join(paths.tasksDir, `${OLD_MERGED}.md`),
      join(paths.queueDir, 'scanned', OLD_MERGED),
      join(paths.queueDir, 'effort', OLD_MERGED),
    ]) {
      expect(existsSync(retained), `artifact should be retained: ${retained}`).toBe(true)
    }
  })

  it('removes the merge guard directory for a pruned task', () => {
    makeTask(OLD_MERGED, 'merged', 'old')
    const mergeGuard = join(paths.queueDir, 'merge-guards', OLD_MERGED)
    mkdirSync(mergeGuard, { recursive: true })
    writeFileSync(join(mergeGuard, 'succeeded'), '')

    const report = pruneTasks(paths, { days: 14, dryRun: false })

    expect(report.removed).toContain(mergeGuard)
    expect(existsSync(mergeGuard)).toBe(false)
  })

  it('retains the status file when removing an earlier artifact fails', () => {
    makeTask(OLD_MERGED, 'merged', 'old')
    fsMockState.removalFailurePath = `${OLD_MERGED}.log`

    expect(() => pruneTasks(paths, { days: 14, dryRun: false }))
      .toThrow('simulated removal failure')

    expect(existsSync(join(paths.statusDir, `${OLD_MERGED}.json`))).toBe(true)
  })

  it('prunes old finished tasks and keeps everything protected', () => {
    setUpFixtures()
    pruneTasks(paths, { days: 14, dryRun: false })

    for (const gone of [
      join(paths.statusDir, `${OLD_MERGED}.json`),
      join(paths.logsDir, `${OLD_MERGED}.log`),
      join(paths.logsDir, `${OLD_MERGED}.merge.log`),
      join(paths.tasksDir, `${OLD_MERGED}.md`),
      join(paths.queueDir, 'scanned', OLD_MERGED),
      join(paths.queueDir, 'effort', OLD_MERGED),
      join(paths.statusDir, `${OLD_NO_CHANGE}.json`),
      join(paths.logsDir, `${OLD_NO_CHANGE}.log`),
      join(paths.tasksDir, `${OLD_NO_CHANGE}.md`),
      join(paths.queueDir, 'desc-index', 'user-deadbeef'),
    ]) {
      expect(existsSync(gone), `should be pruned: ${gone}`).toBe(false)
    }

    expect(existsSync(join(paths.statusDir, '20990101_000000_001_user-new-merged.json'))).toBe(true)
    expect(existsSync(join(paths.tasksDir, '20990101_000000_001_user-new-merged.md'))).toBe(true)
    expect(existsSync(join(paths.statusDir, '20250101_000000_002_user-old-running.json'))).toBe(true)
    for (const retained of [
      join(paths.statusDir, `${OLD_FAILED}.json`),
      join(paths.logsDir, `${OLD_FAILED}.log`),
      join(paths.logsDir, `${OLD_FAILED}.merge.log`),
      join(paths.tasksDir, `${OLD_FAILED}.md`),
      join(paths.queueDir, 'scanned', OLD_FAILED),
      join(paths.queueDir, 'scanned', `${OLD_FAILED}.failed`),
      join(paths.queueDir, 'effort', OLD_FAILED),
    ]) {
      expect(existsSync(retained), `failed-task artifact should be retained: ${retained}`).toBe(true)
    }
    expect(existsSync(join(paths.statusDir, '20250101_000000_003_user-old-worktree.json'))).toBe(true)
    expect(existsSync(join(paths.tasksDir, 'manual-task.md'))).toBe(true)
    expect(existsSync(join(paths.statusDir, 'manual-task.json'))).toBe(false)
    expect(existsSync(join(paths.logsDir, 'orphan-task.log'))).toBe(true)
    expect(existsSync(join(paths.logsDir, 'orphan-task.final'))).toBe(true)
    expect(existsSync(join(paths.logsDir, 'loop.log'))).toBe(true)
  })
})
