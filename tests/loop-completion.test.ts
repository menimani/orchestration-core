import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { TEST_LOCK_BUSY_EXIT_CODE } from '../src/merge.ts'
import { GENERATED_BODY_MARKER } from '../src/prbody.ts'
import {
  configureRemoteDefaultBranch, fakeForge, forgeStatus, git, initializeGitRepo,
  initializeGitRepoWithRemote, logText, logged, makeLoop, paths, prStatusCalls,
  registerLoopHooks, repoRoot, setForgeStatus, stubProject,
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
  function configureLocalRemote(): void {
    initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  }

  it('stops after a repeated push failure without rerunning a passing suite', async () => {
    initializeGitRepo()
    git(['remote', 'add', 'origin', join(repoRoot, 'missing-remote.git')])
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
    initializeGitRepo()
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
    configureLocalRemote()
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

    writeFileSync(join(repoRoot, 'tip-change.txt'), 'new tip\n')
    git(['add', 'tip-change.txt'])
    git(['commit', '-m', 'test: change the gate tip'])

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\nrun\n')
  })

  it('retains an opted-in full-gate suite verdict for the branch tip', async () => {
    configureLocalRemote()
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
    configureLocalRemote()
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
    configureLocalRemote()
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
    configureLocalRemote()
    git(['switch', '-c', 'feature/fetch-retry'])
    const remote = join(repoRoot, 'remote.git')
    git(['remote', 'set-url', '--push', 'origin', remote])
    git(['remote', 'set-url', 'origin', join(repoRoot, 'missing-remote.git')])
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

    git(['remote', 'set-url', 'origin', remote])

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(updatePr).toHaveBeenCalledOnce()
  })

  it('returns failure when the generated PR body cannot be updated', async () => {
    configureLocalRemote()
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

  it('accepts a confirmed hand-edited PR body without overwriting it', async () => {
    configureLocalRemote()
    const loop = makeLoop()
    fakeForge.prBody = async () => 'A person rewrote this summary.'
    const updatePr = vi.fn(async () => {})
    fakeForge.updatePr = updatePr

    expect(await loop.ensureDraftPr('cycle')).toBe(true)
    expect(updatePr).toHaveBeenCalledOnce()
    expect(updatePr).toHaveBeenCalledWith('main', {
      title: 'feat: autonomous scan loop — cycle 0/3',
    })
    expect(readFileSync(join(paths.queueDir, 'pr-url.txt'), 'utf8'))
      .toBe('https://example.test/pull/1\n')
  })

  it('does not overwrite an edited PR body with a displaced generated marker', async () => {
    configureLocalRemote()
    const loop = makeLoop()
    fakeForge.prBody = async () => [
      'A person rewrote this summary.',
      GENERATED_BODY_MARKER,
      'The marker remains only as quoted history.',
    ].join('\n')
    const updatePr = vi.fn(async () => {})
    fakeForge.updatePr = updatePr

    expect(await loop.ensureDraftPr('cycle')).toBe(true)
    expect(updatePr).toHaveBeenCalledWith('main', {
      title: 'feat: autonomous scan loop — cycle 0/3',
    })
  })

  it('creates and summarizes a PR against the remote default branch', async () => {
    initializeGitRepo()
    git(['branch', '-M', 'trunk'])
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'upstream', remote])
    git(['push', '-u', 'upstream', 'trunk'])
    git(['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/trunk'])
    git(['switch', '-c', 'feature/default-base'])
    git(['branch', '--set-upstream-to', 'upstream/trunk'])
    writeFileSync(join(repoRoot, 'feature.txt'), 'feature\n')
    git(['add', 'feature.txt'])
    git(['commit', '-m', 'feat: use the configured base'])
    setForgeStatus({ state: 'none', isDraft: false, url: '', headSha: '', checks: [] })
    const loop = makeLoop()
    const createPr = vi.fn(async () => 'https://example.test/pull/1')
    fakeForge.createPr = createPr

    expect(await loop.ensureDraftPr('final')).toBe(true)

    expect(createPr).toHaveBeenCalledWith(expect.objectContaining({
      base: 'trunk',
      title: 'feat: autonomous scan loop — 1 feature',
      body: expect.stringContaining('- use the configured base'),
    }))
  })

  it('pushes a fork branch to origin while keeping the upstream repository as its PR base', async () => {
    initializeGitRepo()
    configureRemoteDefaultBranch('main', 'upstream')
    const fork = join(repoRoot, 'fork.git')
    execFileSync('git', ['init', '--bare', fork], { windowsHide: true })
    git(['remote', 'add', 'origin', fork])
    git(['push', 'origin', 'main:fork-main'])
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/fork-main'], {
      cwd: fork, windowsHide: true,
    })
    git(['fetch', 'origin'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/fork-main'])
    git(['switch', '-c', 'feature/fork-base'])
    git(['branch', '--set-upstream-to', 'upstream/main'])
    git(['config', 'branch.feature/fork-base.pushRemote', 'origin'])
    writeFileSync(join(repoRoot, 'fork.txt'), 'fork work\n')
    git(['add', 'fork.txt'])
    git(['commit', '-m', 'feat: preserve the upstream base'])
    setForgeStatus({ state: 'none', isDraft: false, url: '', headSha: '', checks: [] })
    const loop = makeLoop()
    const createPr = vi.fn(async () => 'https://example.test/pull/1')
    fakeForge.createPr = createPr

    expect(await loop.ensureDraftPr('final')).toBe(true)

    expect(createPr).toHaveBeenCalledWith(expect.objectContaining({ base: 'main' }))
    expect(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']))
      .toBe('upstream/main')
    expect(execFileSync('git', ['rev-parse', '--verify', 'refs/heads/feature/fork-base'], {
      cwd: fork, encoding: 'utf8', windowsHide: true,
    }).trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('pushes a fresh topic branch through its only remote and establishes the upstream', async () => {
    initializeGitRepoWithRemote()
    git(['switch', '-c', 'feature/fresh-topic'])
    writeFileSync(join(repoRoot, 'fresh.txt'), 'fresh\n')
    git(['add', 'fresh.txt'])
    git(['commit', '-m', 'feat: fresh topic'])
    setForgeStatus({ state: 'none', isDraft: false, url: '', headSha: '', checks: [] })
    const loop = makeLoop()

    expect(await loop.ensureDraftPr('cycle')).toBe(true)

    expect(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']))
      .toBe('origin/feature/fresh-topic')
  })

  it('emits LOOP_DONE verbatim and the rewrite reminder as a formatted event', async () => {
    initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const loop = makeLoop()
    fakeForge.markPrReady = async () => {
      setForgeStatus({ ...forgeStatus, isDraft: false })
    }

    expect(await loop.postLoopPr()).toBe(true)

    const marker = 'LOOP_DONE: https://example.test/pull/1'
    const reminder = 'Status PR body     still reflects history and must be rewritten as a final summary.'
    expect(logged).toContain(marker)
    expect(logged).toContain(reminder)
    expect(logged).toContain(`Completed Loop        PR https://example.test/pull/1`)
    expect(logged.indexOf(marker)).toBeLessThan(logged.indexOf(reminder))
    expect(logged.indexOf(reminder))
      .toBeLessThan(logged.indexOf('Completed Loop        PR https://example.test/pull/1'))
  })

  it('neither promotes nor emits LOOP_DONE while the forge reports an earlier head', async () => {
    const headSha = initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    setForgeStatus({ ...forgeStatus, headSha: 'f'.repeat(40) })
    const loop = makeLoop()
    const markPrReady = vi.fn(async () => {
      setForgeStatus({ ...forgeStatus, isDraft: false })
    })
    fakeForge.markPrReady = markPrReady

    expect(await loop.postLoopPr()).toBe(false)
    expect(markPrReady).not.toHaveBeenCalled()
    expect(logText()).not.toContain('LOOP_DONE')

    setForgeStatus({ ...forgeStatus, headSha })
    expect(await loop.postLoopPr()).toBe(true)
    expect(markPrReady).toHaveBeenCalledTimes(1)
    expect(logged).toContain('LOOP_DONE: https://example.test/pull/1')
  })

  it('reports varying draft promotion errors and stops after two gate failures', async () => {
    initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const loop = makeLoop({}, {
      ...stubProject,
      manualEnvironmentChecks: [{ environment: 'Linux', command: 'npm run test:linux' }],
    })
    let promotions = 0
    fakeForge.markPrReady = async () => {
      promotions += 1
      throw new Error(`promotion failed with diagnostic ${promotions}`)
    }

    expect(await loop.postLoopPr()).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(await loop.postLoopPr()).toBe(false)

    expect(logText()).toContain(
      'WARN could not promote PR: promotion failed with diagnostic 1',
    )
    expect(logText()).toContain(
      'ERROR could not promote PR: promotion failed with diagnostic 2 (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logged.some((line) => line.startsWith('LOOP_DONE:'))).toBe(false)
    expect(logged).not.toContain('Completed Loop        PR https://example.test/pull/1')
    expect(logged.some((line) => line.startsWith('Status Environments'))).toBe(false)
    expect(logged.some((line) => line.startsWith('Status Linux check'))).toBe(false)
  })

  it('treats a PR merged while it is being promoted as complete', async () => {
    initializeGitRepoWithRemote()
    const loop = makeLoop()
    fakeForge.markPrReady = async () => {
      setForgeStatus({ ...forgeStatus, state: 'merged', isDraft: false, headSha: git(['rev-parse', 'HEAD']).trim() })
    }

    expect(await loop.postLoopPr()).toBe(true)

    expect(logged).toContain('LOOP_DONE: https://example.test/pull/1')
    expect(logged).toContain('Completed Loop        PR https://example.test/pull/1')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('opens a new PR and reopens the cycle gate when a merged PR head is behind HEAD', async () => {
    initializeGitRepoWithRemote()
    git(['switch', '-c', 'feature/run-merged-early'])
    writeFileSync(join(repoRoot, 'early.txt'), 'early\n')
    git(['add', 'early.txt'])
    git(['commit', '-m', 'feat: merged with the draft'])
    const mergedHead = git(['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repoRoot, 'late.txt'), 'late\n')
    git(['add', 'late.txt'])
    git(['commit', '-m', 'feat: landed after the merge'])
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
    const headSha = initializeGitRepoWithRemote()
    writeFileSync(join(repoRoot, 'late.txt'), 'late\n')
    git(['add', 'late.txt'])
    git(['commit', '-m', 'feat: landed after the merge'])
    const loop = makeLoop()
    fakeForge.markPrReady = async () => {
      setForgeStatus({ ...forgeStatus, state: 'merged', isDraft: false, headSha })
    }

    expect(await loop.postLoopPr()).toBe(false)

    expect(logText()).not.toContain('LOOP_DONE')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('records a PR merged before the final gate that holds HEAD without opening another', async () => {
    const headSha = initializeGitRepoWithRemote()
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
    initializeGitRepoWithRemote()
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
    initializeGitRepoWithRemote()
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
    initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
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
    initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const loop = makeLoop()
    let calls = 0
    fakeForge.prStatus = async () => {
      calls += 1
      if (calls % 3 === 0) throw new Error('confirmation unavailable')
      return { ...forgeStatus, headSha: git(['rev-parse', 'HEAD']) }
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
    initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
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
    initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
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
