import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { TEST_LOCK_BUSY_EXIT_CODE } from '../src/merge.ts'
import { GENERATED_BODY_MARKER } from '../src/prbody.ts'
import { FAKE_COMMIT } from './fakeRepository.ts'
import {
  fakeForge, forgeStatus, git, logText, logged, makeLoop, paths,
  prStatusCalls, registerLoopHooks, repoRoot, stubProject, useFakeRepository,
  useFakeRepositoryWithRemote,
} from './loopHarness.ts'

const cleanupFailure = vi.hoisted(() => ({ taskId: undefined as string | undefined }))

// Cleanup runs unchanged unless a test names a task whose cleanup must fail once.
vi.mock('../src/cleanup.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cleanup.ts')>()
  return {
    ...actual,
    cleanupTask: (...args: Parameters<typeof actual.cleanupTask>) => {
      if (args[1] === cleanupFailure.taskId) {
        cleanupFailure.taskId = undefined
        throw new Error('worktree is locked')
      }
      actual.cleanupTask(...args)
    },
  }
})

const mergedStatusFailure = vi.hoisted(() => ({
  taskId: undefined as string | undefined,
  onWrite: undefined as (() => void) | undefined,
}))

// Recording a merge runs unchanged unless a test names a task whose process must die
// right after the merged status reaches disk.
vi.mock('../src/status.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/status.ts')>()
  return {
    ...actual,
    writeMergedStatus: async (...args: Parameters<typeof actual.writeMergedStatus>) => {
      if (args[1] !== mergedStatusFailure.taskId) return actual.writeMergedStatus(...args)
      mergedStatusFailure.taskId = undefined
      mergedStatusFailure.onWrite?.()
      await actual.writeMergedStatus(...args)
      throw new Error('process stopped after recording the merge')
    },
  }
})

registerLoopHooks()

describe('completion marker output', () => {
  it('stops after a repeated push failure without rerunning a passing suite', async () => {
    useFakeRepository({
      remotes: [{ name: 'origin', url: join(repoRoot, 'missing-remote.git') }],
      missingRepositories: [join(repoRoot, 'missing-remote.git')],
    })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Marker', cwd: '',
        command: `node -e "require('node:fs').appendFileSync('suite-runs', 'run\\n')"`,
      }],
    }
    const loop = makeLoop({ autoPr: true, taskGate: 'light' }, suiteProject)

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logText()).toContain('WARN could not push branch:')
    expect(logText()).toContain('ERROR could not push branch:')
    expect(logText()).toContain('does not appear to be a git repository')
    expect(logText()).toContain('(repeated 2 times)')
    expect(logText()).not.toContain('CYCLE_COMPLETE:')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\n')
    expect(logged.filter((line) => line === 'Started Suite       cycle 1')).toHaveLength(1)
    expect(prStatusCalls).toBe(0)
  })

  it('defers a cycle gate whose suite waited out the test lock without stopping the loop', async () => {
    useFakeRepository()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Locked suite', cwd: '',
        command: `node -e "require('node:fs').appendFileSync('suite-runs', 'run\\n'); process.exit(${TEST_LOCK_BUSY_EXIT_CODE})"`,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    // Each gate entry runs the suite again rather than keeping a verdict it never had.
    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\nrun\n')
    expect(logText()).toContain('WARN cycle suite deferred: the repository test lock stayed busy')
    expect(logText()).not.toContain('ERROR cycle suite failed')
    expect(logText()).not.toContain('CYCLE_COMPLETE:')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
  })

  it('retains a suite verdict only while PR retries use the same branch tip', async () => {
    const repository = useFakeRepositoryWithRemote()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Marker', cwd: '',
        command: `node -e "require('node:fs').appendFileSync('suite-runs', 'run\\n')"`,
      }],
    }
    const loop = makeLoop({ autoPr: true, taskGate: 'light' }, suiteProject)
    fakeForge.prBody = async () => { throw new Error('body read failed') }

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\n')
    expect(logText()).toContain('ERROR could not read PR body: body read failed (repeated 2 times)')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)

    repository.state.ancestors = [repository.state.head]
    repository.state.head = FAKE_COMMIT
    repository.state.commitsAhead['origin/main'] = 1
    repository.state.commits['origin/main'] = [
      { sha: FAKE_COMMIT, subject: 'test: change the gate tip', files: ['tip-change.txt'] },
    ]

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\nrun\n')
  })

  it('retains an opted-in full-gate suite verdict for the branch tip', async () => {
    useFakeRepositoryWithRemote()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Browser smoke', cwd: '', runAtEveryTaskGate: true,
        command: `node -e "require('node:fs').appendFileSync('suite-runs', 'run\\n')"`,
      }],
    }
    const loop = makeLoop({ autoPr: true, taskGate: 'full' }, suiteProject)
    fakeForge.prBody = async () => { throw new Error('body read failed') }

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\n')
    expect(readFileSync(join(paths.queueDir, 'cycle-suite-tip-1'), 'utf8').trim())
      .toBe(git(['rev-parse', 'HEAD']).trim())
    expect(logged.filter((line) => line === 'Started Suite       cycle 1')).toHaveLength(1)
  })

  it('retries the cycle gate when the existing PR body cannot be read', async () => {
    useFakeRepositoryWithRemote()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ autoPr: true, reviewEnabled: true, autoReview: false })
    let reads = 0
    fakeForge.prBody = async () => {
      if (reads++ === 0) throw new Error('body read failed')
      return GENERATED_BODY_MARKER
    }
    const updatePr = vi.fn(async () => {})
    fakeForge.updatePr = updatePr

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(logText()).toContain('WARN could not read PR body: body read failed')
    expect(updatePr).not.toHaveBeenCalled()

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(updatePr).toHaveBeenCalledOnce()
  })

  it('retries the cycle gate when the PR status cannot be read', async () => {
    useFakeRepositoryWithRemote()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ autoPr: true, reviewEnabled: true, autoReview: false })
    let reads = 0
    fakeForge.prStatus = async () => {
      if (reads++ === 0) throw new Error('status read failed')
      return forgeStatus
    }
    fakeForge.prBody = async () => GENERATED_BODY_MARKER
    const updatePr = vi.fn(async () => {})
    fakeForge.updatePr = updatePr

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(logText()).toContain('WARN could not check PR status: status read failed')
    expect(updatePr).not.toHaveBeenCalled()

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(updatePr).toHaveBeenCalledOnce()
  })

  it('waits for the default branch fetch before completing the cycle', async () => {
    const repository = useFakeRepositoryWithRemote()
    repository.state.branch = 'feature/fetch-retry'
    repository.state.branches.push('feature/fetch-retry')
    const [origin] = repository.state.remotes
    const remote = join(repoRoot, 'remote.git')
    origin!.pushUrl = remote
    origin!.url = join(repoRoot, 'missing-remote.git')
    repository.state.missingRepositories.push(origin!.url)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ autoPr: true, reviewEnabled: true, autoReview: false })
    const updatePr = vi.fn(async () => {})
    fakeForge.prBody = async () => GENERATED_BODY_MARKER
    fakeForge.updatePr = updatePr

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(logText()).toContain('WARN could not fetch origin/main:')
    expect(prStatusCalls).toBe(0)
    expect(updatePr).not.toHaveBeenCalled()

    origin!.url = remote

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(updatePr).toHaveBeenCalledOnce()
  })

  it('returns failure when the generated PR body cannot be updated', async () => {
    useFakeRepositoryWithRemote()
    const loop = makeLoop()
    fakeForge.prBody = async () => GENERATED_BODY_MARKER
    fakeForge.updatePr = async () => {
      throw new Error('body update failed')
    }

    expect(await loop.ensureDraftPr('cycle')).toBe(false)
    expect(logText()).toContain('WARN could not update PR body: body update failed')
    expect(existsSync(join(paths.queueDir, 'pr-url.txt'))).toBe(false)

    expect(await loop.ensureDraftPr('cycle')).toBe(false)
    expect(logText()).toContain(
      'ERROR could not update PR body: body update failed (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })
})
