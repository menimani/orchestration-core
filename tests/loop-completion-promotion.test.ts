import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FAKE_COMMIT, FAKE_HEAD, FAKE_LATER_COMMIT } from './fakeRepository.ts'
import {
  fakeForge, forgeStatus, logText, logged, makeLoop, paths, prStatusCalls, registerLoopHooks,
  setForgeStatus, useFakeRepositoryWithRemote,
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
  it('treats a PR merged while it is being promoted as complete', async () => {
    const repository = useFakeRepositoryWithRemote()
    const loop = makeLoop()
    fakeForge.markPrReady = async () => {
      setForgeStatus({ ...forgeStatus, state: 'merged', isDraft: false, headSha: repository.state.head })
    }

    expect(await loop.postLoopPr()).toBe(true)

    expect(logged).toContain('LOOP_DONE: https://example.test/pull/1')
    expect(logged).toContain('Completed Loop        PR https://example.test/pull/1')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('opens a new PR and reopens the cycle gate when a merged PR head is behind HEAD', async () => {
    const repository = useFakeRepositoryWithRemote()
    const mergedHead = FAKE_COMMIT
    repository.state.branch = 'feature/run-merged-early'
    repository.state.branches.push('feature/run-merged-early')
    repository.state.head = FAKE_LATER_COMMIT
    repository.state.ancestors = [FAKE_HEAD, mergedHead]
    repository.state.commitsAhead['origin/main'] = 2
    repository.state.commits['origin/main'] = [
      { sha: mergedHead, subject: 'feat: merged with the draft', files: ['early.txt'] },
      { sha: FAKE_LATER_COMMIT, subject: 'feat: landed after the merge', files: ['late.txt'] },
    ]
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-1'), '')
    writeFileSync(join(paths.queueDir, 'cycle-resume-1'), '')
    setForgeStatus({
      state: 'merged', isDraft: false, url: 'https://example.test/pull/1', headSha: mergedHead, checks: [],
    })
    const loop = makeLoop()
    const createPr = vi.fn(async () => {
      setForgeStatus({ state: 'open', isDraft: true, url: 'https://example.test/pull/2', headSha: '', checks: [] })
      return 'https://example.test/pull/2'
    })
    fakeForge.createPr = createPr
    const markPrReady = vi.fn(async () => {
      setForgeStatus({ ...forgeStatus, isDraft: false })
    })
    fakeForge.markPrReady = markPrReady

    expect(await loop.postLoopPr()).toBe(false)

    expect(createPr).toHaveBeenCalledOnce()
    expect(markPrReady).not.toHaveBeenCalled()
    expect(logText()).not.toContain('LOOP_DONE')
    expect(logText()).toContain('PR merged without the newest commits; gating them again in https://example.test/pull/2')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'cycle-resume-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    // Once the reopened gate has passed again, the new PR is promoted as usual.
    expect(await loop.postLoopPr()).toBe(true)
    expect(createPr).toHaveBeenCalledOnce()
    expect(markPrReady).toHaveBeenCalledOnce()
    expect(logged).toContain('LOOP_DONE: https://example.test/pull/2')
  })

  it('does not finish on a PR merged during promotion whose head is behind HEAD', async () => {
    const repository = useFakeRepositoryWithRemote()
    const headSha = repository.state.head
    repository.state.head = FAKE_COMMIT
    repository.state.ancestors = [headSha]
    repository.state.commitsAhead['origin/main'] = 1
    repository.state.commits['origin/main'] = [
      { sha: FAKE_COMMIT, subject: 'feat: landed after the merge', files: ['late.txt'] },
    ]
    const loop = makeLoop()
    fakeForge.markPrReady = async () => {
      setForgeStatus({ ...forgeStatus, state: 'merged', isDraft: false, headSha })
    }

    expect(await loop.postLoopPr()).toBe(false)

    expect(logText()).not.toContain('LOOP_DONE')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('records a PR merged before the final gate that holds HEAD without opening another', async () => {
    const headSha = useFakeRepositoryWithRemote().state.head
    setForgeStatus({
      state: 'merged', isDraft: false, url: 'https://example.test/pull/1', headSha, checks: [],
    })
    const loop = makeLoop()
    const createPr = vi.fn(async () => 'https://example.test/pull/2')
    fakeForge.createPr = createPr

    expect(await loop.ensureDraftPr('final')).toBe(true)

    expect(createPr).not.toHaveBeenCalled()
    expect(readFileSync(join(paths.queueDir, 'pr-url.txt'), 'utf8'))
      .toBe('https://example.test/pull/1\n')
    expect(logText()).not.toContain('WARN')
  })

  it('fails the final gate when a merged PR head cannot be compared with HEAD', async () => {
    useFakeRepositoryWithRemote()
    setForgeStatus({
      state: 'merged', isDraft: false, url: 'https://example.test/pull/1', headSha: 'f'.repeat(40), checks: [],
    })
    const loop = makeLoop()
    const createPr = vi.fn(async () => 'https://example.test/pull/2')
    fakeForge.createPr = createPr

    expect(await loop.ensureDraftPr('final')).toBe(false)

    expect(createPr).not.toHaveBeenCalled()
    expect(existsSync(join(paths.queueDir, 'pr-url.txt'))).toBe(false)
    expect(logged.filter((line) => line.startsWith('WARN could not compare merged PR head with HEAD: ')))
      .toHaveLength(1)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('reports a PR closed while it is being promoted and stops after repetition', async () => {
    useFakeRepositoryWithRemote()
    const loop = makeLoop()
    const markPrReady = vi.fn(async () => {
      setForgeStatus({ ...forgeStatus, state: 'closed', isDraft: false })
    })
    fakeForge.markPrReady = markPrReady

    expect(await loop.postLoopPr()).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(await loop.postLoopPr()).toBe(false)

    expect(markPrReady).toHaveBeenCalledOnce()
    expect(logText()).toContain('WARN could not promote PR because it is closed')
    expect(logText()).toContain(
      'ERROR could not promote PR because it is closed (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logged.some((line) => line.startsWith('LOOP_DONE:'))).toBe(false)
  })

  it('reports repeated pre-promotion status errors and stops the loop', async () => {
    useFakeRepositoryWithRemote()
    const loop = makeLoop()
    let calls = 0
    fakeForge.prStatus = async () => {
      calls += 1
      if (calls % 2 === 0) throw new Error('status unavailable')
      return forgeStatus
    }

    expect(await loop.postLoopPr()).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(await loop.postLoopPr()).toBe(false)

    expect(logText()).toContain(
      'WARN could not check PR status before promotion: status unavailable',
    )
    expect(logText()).toContain(
      'ERROR could not check PR status before promotion: status unavailable (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logged.some((line) => line.startsWith('Status Environments'))).toBe(false)
  })

  it('reports repeated post-promotion status errors and stops the loop', async () => {
    const repository = useFakeRepositoryWithRemote()
    const loop = makeLoop()
    let calls = 0
    fakeForge.prStatus = async () => {
      calls += 1
      if (calls % 3 === 0) throw new Error('confirmation unavailable')
      return { ...forgeStatus, headSha: repository.state.head }
    }

    expect(await loop.postLoopPr()).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(await loop.postLoopPr()).toBe(false)

    expect(logText()).toContain(
      'WARN could not confirm PR status after promotion: confirmation unavailable',
    )
    expect(logText()).toContain(
      'ERROR could not confirm PR status after promotion: confirmation unavailable (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logged.some((line) => line.startsWith('Status Environments'))).toBe(false)
  })

  it('reports a persistently draft PR and stops without emitting LOOP_DONE', async () => {
    useFakeRepositoryWithRemote()
    const loop = makeLoop()

    expect(await loop.postLoopPr()).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(await loop.postLoopPr()).toBe(false)

    expect(prStatusCalls).toBe(6)
    expect(logText()).toContain('WARN could not confirm PR promotion; PR is still draft')
    expect(logText()).toContain(
      'ERROR could not confirm PR promotion; PR is still draft (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logged.some((line) => line.startsWith('LOOP_DONE:'))).toBe(false)
    expect(logged).not.toContain('Completed Loop        PR https://example.test/pull/1')
    expect(logged.some((line) => line.startsWith('Status Environments'))).toBe(false)
  })

  it('keeps the final gate state until draft promotion is confirmed', async () => {
    useFakeRepositoryWithRemote()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ autoPr: true, reviewEnabled: false, maxScanCycles: 1 })
    let promotions = 0
    fakeForge.markPrReady = async () => {
      promotions += 1
      if (promotions === 1) throw new Error('promotion failed')
      if (promotions === 3) setForgeStatus({ ...forgeStatus, isDraft: false })
    }

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(readFileSync(join(paths.queueDir, 'scan-count.txt'), 'utf8')).toBe('1\n')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(logged.some((line) => line.startsWith('LOOP_DONE:'))).toBe(false)

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(readFileSync(join(paths.queueDir, 'scan-count.txt'), 'utf8')).toBe('1\n')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(logged.some((line) => line.startsWith('LOOP_DONE:'))).toBe(false)

    expect(await loop.triggerScanIfIdle()).toBe('done')
    expect(readFileSync(join(paths.queueDir, 'scan-count.txt'), 'utf8')).toBe('0\n')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(logged.some((line) => line.startsWith('LOOP_DONE:'))).toBe(true)
  })
})
