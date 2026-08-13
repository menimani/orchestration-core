import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type LoopConfig } from '../src/config.ts'
import { createLoop, type Loop } from '../src/loop.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { stubProject } from './stubProject.ts'

// The branch-state rules ported from test-loop-branch-state.sh: a stopped loop keeps
// its cycle state so it can resume after an environment repair, but that state belongs
// only to the branch which created it.

let repoRoot: string
let paths: OrchPaths
let logged: string[]
let runnerStarts: string[]

function makeLoop(overrides: Partial<LoopConfig> = {}): Loop {
  return createLoop({
    paths,
    config: { ...loadConfig({}), ...overrides },
    forge: makeFakeForge(),
    runner: {
      sharedSkills: fakeRunnerSharedSkills,
      start: async (options) => {
        runnerStarts.push(options.specFile)
        return process.pid
      },
    },
    project: stubProject,
    log: (line) => logged.push(line),
    now: () => new Date(),
  })
}

const cycleFileNames = [
  'cycle-complete-4', 'cycle-suite-tip-4', 'cycle-resume-4', 'ci-fix-emitted-4', 'review-round-4',
  'review-id-4', 'decisions.txt', 'failed-4', 'scan-yield-4', 'pr-url.txt',
  'empty-scan-count.txt',
]

function seedState(): void {
  mkdirSync(join(paths.queueDir, 'scanned'), { recursive: true })
  mkdirSync(join(paths.queueDir, 'desc-index'), { recursive: true })
  writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
  for (const name of cycleFileNames) {
    writeFileSync(join(paths.queueDir, name), 'cycle state\n')
  }
  writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '3\n')
  writeFileSync(join(paths.queueDir, 'scanned', 'completed-task'), 'terminal marker\n')
  writeFileSync(join(paths.queueDir, 'scanned', 'failed-task.failed'), 'terminal marker\n')
  writeFileSync(join(paths.statusDir, 'completed-task.json'),
    '{"task_id":"completed-task","status":"completed"}')
  writeFileSync(join(paths.statusDir, 'failed-task.json'),
    '{"task_id":"failed-task","status":"failed"}')
  writeFileSync(join(paths.queueDir, 'backlog.txt'), 'queued-task:0\n')
  writeFileSync(join(paths.queueDir, 'desc-index', 'user-12345678'), 'indexed-task\n')
}

function assertPersistentState(): void {
  expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8').trim()).toBe('queued-task:0')
  expect(readFileSync(join(paths.queueDir, 'desc-index', 'user-12345678'), 'utf8').trim()).toBe('indexed-task')
  expect(readFileSync(join(paths.statusDir, 'completed-task.json'), 'utf8'))
    .toBe('{"task_id":"completed-task","status":"completed"}')
  expect(readFileSync(join(paths.statusDir, 'failed-task.json'), 'utf8'))
    .toBe('{"task_id":"failed-task","status":"failed"}')
  expect(readFileSync(join(paths.queueDir, 'scanned', 'completed-task'), 'utf8').trim()).toBe('terminal marker')
  expect(readFileSync(join(paths.queueDir, 'scanned', 'failed-task.failed'), 'utf8').trim()).toBe('terminal marker')
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-branch-'))
  execFileSync('git', ['init', '-q', '-b', 'current-branch'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'chore: initial commit'], {
    cwd: repoRoot,
  })
  paths = orchPaths(repoRoot)
  logged = []
  runnerStarts = []
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('initializeSessionStateForBranch', () => {
  it('resets cycle state when the branch changed, keeping queue and terminal markers', () => {
    seedState()
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'previous-branch\n')

    makeLoop().initializeSessionStateForBranch()

    expect(logged).toEqual([])
    expect(readFileSync(join(paths.queueDir, 'run-branch.txt'), 'utf8').trim()).toBe('current-branch')
    expect(readFileSync(join(paths.queueDir, 'scan-count.txt'), 'utf8').trim()).toBe('0')
    for (const name of cycleFileNames) {
      expect(existsSync(join(paths.queueDir, name)), `cycle state survived: ${name}`).toBe(false)
    }
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('0')
    assertPersistentState()
  })

  it('preserves an intentional mid-cycle resume on the same branch', () => {
    seedState()
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'current-branch\n')

    makeLoop().initializeSessionStateForBranch()

    expect(logged).toHaveLength(0)
    expect(readFileSync(join(paths.queueDir, 'scan-count.txt'), 'utf8').trim()).toBe('4')
    for (const name of cycleFileNames) {
      expect(readFileSync(join(paths.queueDir, name), 'utf8').trim()).toBe('cycle state')
    }
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('3')
    assertPersistentState()
  })

  it('resets the merge streak when no previous run was recorded', () => {
    seedState()

    makeLoop().initializeSessionStateForBranch()

    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('0')
  })
})

describe('validatePushTarget', () => {
  it('stops startup when an auto-PR branch has no push target', () => {
    expect(makeLoop({ autoPr: true }).validatePushTarget()).toBe(false)

    expect(logged).toContain(
      'ERROR current branch cannot be pushed: repository has no configured remote',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })

  it('does not require a push target when the run will not publish a PR', () => {
    expect(makeLoop({ autoPr: false, workerMode: false }).validatePushTarget()).toBe(true)

    expect(logged).toEqual([])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })
})

describe('poll branch guard', () => {
  it('stops before starting or processing tasks when the checkout branch mismatches the run', async () => {
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'recorded-branch\n')
    writeFileSync(join(paths.tasksDir, 'queued-task.md'), '# queued task\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), 'queued-task:0\n')
    writeFileSync(join(paths.statusDir, 'completed-task.json'),
      '{"task_id":"completed-task","status":"completed","pid":null}')

    expect(await makeLoop({ autoMerge: true, scanEnabled: false }).poll()).toBe('stopped')

    expect(logged).toContain('ERROR checkout current-branch does not match run branch recorded-branch')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(runnerStarts).toHaveLength(0)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe('queued-task:0\n')
    expect(existsSync(join(paths.queueDir, 'scanned', 'completed-task'))).toBe(false)
  })

  it('continues processing when the checkout branch matches the run', async () => {
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'current-branch\n')
    writeFileSync(join(paths.tasksDir, 'queued-task.md'), '# queued task\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), 'queued-task:0\n')

    expect(await makeLoop({ autoMerge: false, scanEnabled: false }).poll()).toBe('continue')

    expect(runnerStarts).toHaveLength(1)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe('')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })
})
