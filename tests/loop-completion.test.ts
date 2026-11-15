import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import { GENERATED_BODY_MARKER } from '../src/prbody.ts'
import {
  configureLocalRemote, configureRemoteDefaultBranch, fakeForge, forgeStatus, git,
  initializeGitRepo, initializeGitRepoWithRemote, logText, logged, makeLoop, paths,
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
  function configureUnopenedPrBranch(): void {
    initializeGitRepoWithRemote()
    git(['switch', '-c', 'feature/unopened-pr'])
    git(['branch', '--set-upstream-to', 'origin/main'])
    writeFileSync(join(repoRoot, 'feature.txt'), 'feature\n')
    git(['add', 'feature.txt'])
    git(['commit', '-m', 'feat: needs a new PR'])
    setForgeStatus({ state: 'none', isDraft: false, url: '', headSha: '', checks: [] })
  }

  it('stops after the draft PR cannot be created twice', async () => {
    configureUnopenedPrBranch()
    const loop = makeLoop()
    let attempts = 0
    fakeForge.createPr = async () => {
      attempts += 1
      throw new Error(`creation failed with diagnostic ${attempts}`)
    }

    expect(await loop.ensureDraftPr('cycle')).toBe(false)
    expect(logText()).toContain('WARN could not create PR: creation failed with diagnostic 1')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    expect(await loop.ensureDraftPr('cycle')).toBe(false)
    expect(logText()).toContain(
      'ERROR could not create PR: creation failed with diagnostic 2 (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'pr-url.txt'))).toBe(false)
  })

  it('does not count a rate-limited draft PR creation as a gate failure', async () => {
    configureUnopenedPrBranch()
    const loop = makeLoop()
    // A reset already in the past lifts the forge pause at once, so the next attempt
    // reaches createPr and shows whether the rate limit was counted.
    const failures = [new ForgeRateLimitError(new Date(0)), new Error('forge outage')]
    const createPr = vi.fn(async (): Promise<string> => {
      throw failures.shift()
    })
    fakeForge.createPr = createPr

    expect(await loop.ensureDraftPr('cycle')).toBe(false)
    expect(logText()).not.toContain('could not create PR')
    expect(await loop.ensureDraftPr('cycle')).toBe(false)

    expect(createPr).toHaveBeenCalledTimes(2)
    expect(logged.filter((line) => line.includes('could not create PR'))).toEqual([
      expect.stringContaining('WARN could not create PR: forge outage'),
    ])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('clears the draft PR failure count once creation succeeds', async () => {
    configureUnopenedPrBranch()
    const loop = makeLoop()
    const outcomes = ['first outage', 'created', 'second outage']
    fakeForge.createPr = async () => {
      const outcome = outcomes.shift()
      if (outcome !== 'created') throw new Error(outcome)
      return 'https://example.test/pull/1'
    }

    expect(await loop.ensureDraftPr('cycle')).toBe(false)
    expect(await loop.ensureDraftPr('cycle')).toBe(true)
    expect(readFileSync(join(paths.queueDir, 'pr-url.txt'), 'utf8'))
      .toBe('https://example.test/pull/1\n')
    expect(await loop.ensureDraftPr('cycle')).toBe(false)

    expect(logged.filter((line) => line.includes('could not create PR'))).toEqual([
      expect.stringContaining('WARN could not create PR: first outage'),
      expect.stringContaining('WARN could not create PR: second outage'),
    ])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
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
})
