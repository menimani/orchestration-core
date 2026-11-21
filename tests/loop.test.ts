import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import { normalizeEntry } from '../src/adapters/forge-github.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig, type LoopConfig } from '../src/config.ts'
import {
  buildIssueBody, issueNumbersForTask, recordIssuesForTask, LABEL_FINDING,
  LABEL_GROUP_SINGLETON, LABEL_IN_PROGRESS, LABEL_READY, LABEL_RETRY_EXHAUSTED,
  LABEL_UNTRUSTED_AUTHOR,
} from '../src/issueQueue.ts'
import { createLoop, formatEventLine, type Loop } from '../src/loop.ts'
import { pendingOrchestrationDepsFile, syncOrchestrationDepsAtStartup } from '../src/merge.ts'
import { finalMessageFile, statusFile } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import {
  fakeForge, fakeRepositoryDeps, forgeStatus, initializeGitRepo, logText, logged,
  makeFakeCompletedTask, makeForge, makeLoop, makeRunner, paths, registerLoopHooks, repoRoot,
  runnerStarts, setForgeStatus, stubProject, useFakeRepository, writeFinal, writeRawStatus,
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

describe('formatEventLine', () => {
  it('pads subjects to a fixed column and separates longer subjects', () => {
    expect(formatEventLine('Claimed', '064_auto', '#349')).toBe('Claimed 064_auto    #349')
    expect(formatEventLine('Started', '227_review', 'effort medium'))
      .toBe('Started 227_review  effort medium')
    expect(formatEventLine('Failed', 'subject-over-12', 'log task.log'))
      .toBe('Failed subject-over-12  log task.log')
  })

  it('does not add trailing padding without a detail', () => {
    expect(formatEventLine('Completed')).toBe('Completed')
    expect(formatEventLine('Completed', '064_auto')).toBe('Completed 064_auto')
  })
})

describe('live loop configuration', () => {
  function loopWithConfig(config: LoopConfig): Loop {
    return createLoop({
      paths,
      config,
      forge: makeForge(),
      runner: makeRunner(),
      project: stubProject,
      log: (line) => logged.push(line),
      now: () => new Date(2026, 7, 8, 12, 0, 0),
      ...fakeRepositoryDeps(),
    })
  }

  it('uses a changed live setting on the next poll and reports it', async () => {
    useFakeRepository()
    const filePath = join(paths.root, 'config.json')
    writeFileSync(filePath, JSON.stringify({
      MAX_PARALLEL: 1, SCAN_ENABLED: false, AUTO_MERGE: false,
    }))
    const config = loadConfig({}, {
      filePath,
      onEvent: (event) => logged.push(event.message),
    })
    const loop = loopWithConfig(config)
    loop.initializeSessionStateForBranch()
    const taskIds = [
      '20260820_000001_001_auto-first-live-task',
      '20260820_000002_002_auto-second-live-task',
    ]
    for (const taskId of taskIds) writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# task\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), `${taskIds[0]}:0\n${taskIds[1]}:0\n`)

    expect(await loop.poll()).toBe('continue')
    expect(runnerStarts).toHaveLength(1)

    writeFileSync(filePath, JSON.stringify({
      MAX_PARALLEL: 12, SCAN_ENABLED: false, AUTO_MERGE: false,
    }))
    expect(await loop.poll()).toBe('continue')

    expect(runnerStarts).toHaveLength(2)
    expect(logged).toContain("MAX_PARALLEL changed from '1' to '12'")
  })

  it('keeps a pinned setting and reports why its file change was ignored', () => {
    const filePath = join(paths.root, 'config.json')
    writeFileSync(filePath, JSON.stringify({ FORGE: 'github' }))
    const config = loadConfig({}, {
      filePath,
      onEvent: (event) => logged.push(event.message),
    })
    expect(config.forge).toBe('github')

    writeFileSync(filePath, JSON.stringify({ FORGE: 'another-forge-provider' }))

    expect(config.forge).toBe('github')
    expect(logText()).toContain(
      "Ignored FORGE change from 'github' to 'another-forge-provider'",
    )
    expect(logText()).toContain('in-flight work owned by a component no longer in use')
  })

  it('stops polling when a live configuration update is invalid', async () => {
    useFakeRepository()
    const filePath = join(paths.root, 'config.json')
    writeFileSync(filePath, JSON.stringify({
      MAX_PARALLEL: 1, SCAN_ENABLED: false, AUTO_MERGE: false,
    }))
    const config = loadConfig({}, {
      filePath,
      onEvent: (event) => logged.push(event.message),
    })
    const loop = loopWithConfig(config)
    loop.initializeSessionStateForBranch()
    const taskId = '20260820_000003_003_auto-invalid-live-configuration'
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# task\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), `${taskId}:0\n`)
    writeFileSync(filePath, JSON.stringify({
      MAX_PARALLEL: 0, SCAN_ENABLED: false, AUTO_MERGE: false,
    }))

    await expect(loop.poll()).rejects.toThrow(
      `Invalid configuration file ${filePath} (setting: MAX_PARALLEL)`,
    )
    expect(runnerStarts).toHaveLength(0)
    expect(logText()).toMatch(/setting: MAX_PARALLEL.*must be at least 1/)
  })

  it('retains the existing loop behavior when the configuration file is absent', async () => {
    const config = loadConfig({
      SCAN_ENABLED: 'false', AUTO_PR: 'false', REVIEW_ENABLED: 'false',
    }, { filePath: join(paths.root, 'missing-config.json') })
    const loop = loopWithConfig(config)

    expect(config.maxParallel).toBe(3)
    expect(await loop.triggerScanIfIdle()).toBe('done')
    expect(runnerStarts).toHaveLength(0)
  })
})

describe('daemon startup', () => {
  function fixturePackageRoot(): string {
    return join(repoRoot, 'orchestration', 'ts')
  }

  function writeOrchestrationManifests(lockVersion: string): void {
    mkdirSync(join(repoRoot, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(repoRoot, 'orchestration', 'ts', 'package.json'), JSON.stringify({
      dependencies: { zod: '^4.4.3' },
    }))
    writeFileSync(join(repoRoot, 'orchestration', 'ts', 'package-lock.json'), lockVersion)
  }

  function successfulInstall(): void {
    const packageDir = join(repoRoot, 'orchestration', 'ts', 'node_modules', 'zod')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), '{}\n')
  }

  it('records the installed lockfile and skips a synchronized restart', () => {
    writeOrchestrationManifests('{"lockfileVersion":3}\n')
    const install = vi.fn(successfulInstall)
    syncOrchestrationDepsAtStartup(
      paths,
      (name, subject) => logged.push(`${name} ${subject}`),
      { install, packageRoot: fixturePackageRoot() },
    )

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(join(repoRoot, 'orchestration', 'ts'))
    expect(logged).toContain('Installed at startup')

    syncOrchestrationDepsAtStartup(paths, vi.fn(), {
      install,
      packageRoot: fixturePackageRoot(),
    })

    expect(install).toHaveBeenCalledOnce()
  })

  it('announces a startup install before it starts and only when one runs', () => {
    writeOrchestrationManifests('{"lockfileVersion":3}\n')
    const order: string[] = []
    const install = vi.fn(() => {
      order.push('install')
      successfulInstall()
    })
    const beforeInstall = vi.fn(() => {
      order.push('announce')
      return true
    })
    const packageRoot = fixturePackageRoot()

    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install, packageRoot }, beforeInstall)
    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install, packageRoot }, beforeInstall)

    expect(order).toEqual(['announce', 'install'])
  })

  it('retries a durable pending sync even when the recorded lockfile is current', () => {
    writeOrchestrationManifests('{"lockfileVersion":3}\n')
    const install = vi.fn(successfulInstall)
    const packageRoot = fixturePackageRoot()
    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install, packageRoot })
    const pendingFile = pendingOrchestrationDepsFile(paths, packageRoot)
    writeFileSync(pendingFile, '{}\n')

    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install, packageRoot })

    expect(install).toHaveBeenCalledTimes(2)
    expect(existsSync(pendingFile)).toBe(false)
  })

  it('stops startup with recovery instructions after a lockfile upgrade fails', () => {
    writeOrchestrationManifests('{"lockfileVersion":3}\n')
    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install: successfulInstall, packageRoot: fixturePackageRoot() })
    writeFileSync(
      join(repoRoot, 'orchestration', 'ts', 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"node_modules/zod":{"version":"4.5.0"}}}\n',
    )
    const failedInstall = vi.fn(() => { throw new Error('registry unavailable') })

    expect(() => syncOrchestrationDepsAtStartup(paths, vi.fn(), {
      install: failedInstall,
      packageRoot: fixturePackageRoot(),
    })).toThrow(/Run "npm ci --no-audit --no-fund".*then restart the loop/)

    expect(failedInstall).toHaveBeenCalledOnce()
  })

  it('synchronizes a package at the repository root', () => {
    writeFileSync(join(repoRoot, 'package.json'), '{"dependencies":{}}\n')
    writeFileSync(join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3}\n')
    const install = vi.fn()

    syncOrchestrationDepsAtStartup(paths, vi.fn(), {
      install,
      packageRoot: repoRoot,
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(repoRoot)
  })

  it('leaves a package outside the repository alone', () => {
    // A CLI pointed at another checkout — a fixture, another clone — must never
    // reinstall the package it is itself running from. The suite learned this the hard
    // way: the real package's node_modules was reinstalled mid-test-run.
    writeOrchestrationManifests('{"lockfileVersion":3}\n')
    const install = vi.fn(successfulInstall)
    const packageRoot = mkdtempSync(join(tmpdir(), 'orch-elsewhere-'))

    try {
      syncOrchestrationDepsAtStartup(paths, vi.fn(), { install, packageRoot })

      expect(install).not.toHaveBeenCalled()
    } finally {
      rmSync(packageRoot, { recursive: true, force: true })
    }
  })
})

describe('status file safety', () => {
  it('stops the poll when an existing task status is malformed', async () => {
    useFakeRepository({ repository: false })
    const taskId = '20260811_000000_001_user-existing'
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# Existing task\n')
    writeFileSync(statusFile(paths, taskId), '{"status":"running"')

    const loop = makeLoop({ scanEnabled: false, autoMerge: false })
    await expect(loop.poll()).rejects.toThrow(SyntaxError)
  })

  it('stops the poll when an existing task status is structurally invalid', async () => {
    useFakeRepository({ repository: false })
    const taskId = '20260811_000000_001_user-existing'
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# Existing task\n')
    writeFileSync(statusFile(paths, taskId), '{}')

    const loop = makeLoop({ scanEnabled: false, autoMerge: false })
    await expect(loop.poll()).rejects.toThrow(
      `Status file for ${taskId} failed schema validation`,
    )
  })

})

describe('persisted counter safety', () => {
  it.each(['', 'not-a-count', '1 2', '-1', '9007199254740992'])(
    'stops with a diagnostic instead of resetting a malformed scan count %j',
    async (value) => {
      useFakeRepository()
      const loop = makeLoop({ scanEnabled: false, autoMerge: false })
      loop.initializeSessionStateForBranch()
      writeFileSync(join(paths.queueDir, 'scan-count.txt'), value)

      expect(await loop.poll()).toBe('stopped')

      expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
      expect(logged).toContain(
        'ERROR persisted counter queue/scan-count.txt is invalid; expected a non-negative integer; stopping the loop',
      )
    },
  )

  it('rejects a malformed task-growth count without overwriting it', () => {
    const countFile = join(paths.queueDir, 'total-task-count.txt')
    writeFileSync(countFile, 'unknown\n')
    const loop = makeLoop()

    expect(() => loop.countAllTasks()).toThrow('persisted counter queue/total-task-count.txt is invalid')

    expect(readFileSync(countFile, 'utf8')).toBe('unknown\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })

  it('rejects a malformed merge-failure count without incrementing it', () => {
    const countFile = join(paths.queueDir, 'merge-failure-count.txt')
    writeFileSync(countFile, 'NaN\n')
    const loop = makeLoop()

    expect(() => loop.noteMergeFailure(join(paths.logsDir, 'missing.merge.log')))
      .toThrow('persisted counter queue/merge-failure-count.txt is invalid')

    expect(readFileSync(countFile, 'utf8')).toBe('NaN\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })
})

describe('forge poll budget', () => {
  it('claims ready findings for the same titled file as one task', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const requirements = [
      '[BUG] `src/shared.ts` narrows the stored value incorrectly',
      '[BUG] `src/shared.ts` emits the narrowed value incorrectly',
    ]
    const issueNumbers = await Promise.all(requirements.map((requirement) =>
      fakeForge.createIssue({
        title: requirement,
        body: buildIssueBody(requirement, 'scan-task'),
        labels: [LABEL_FINDING, LABEL_READY],
      })))

    expect(await loop.poll()).toBe('continue')

    expect(runnerStarts).toHaveLength(1)
    const taskId = runnerStarts[0]!.replace(/^.*[\\/]/, '').replace(/\.md$/, '')
    expect(issueNumbersForTask(paths, taskId)).toEqual(issueNumbers)
    const spec = readFileSync(join(paths.tasksDir, `${taskId}.md`), 'utf8')
    expect(spec.indexOf(requirements[0]!)).toBeLessThan(spec.indexOf(requirements[1]!))
    expect(spec).toContain(`REQUIREMENT_COMPLETE: #${issueNumbers[0]}`)
    expect(spec).toContain(`REQUIREMENT_COMPLETE: #${issueNumbers[1]}`)
    for (const issueNumber of issueNumbers) {
      expect((await fakeForge.getIssue(issueNumber)).labels).toContain(LABEL_IN_PROGRESS)
    }
  })

  it('gives a single claimed test finding the tests pitfall list', async () => {
    useFakeRepository()
    mkdirSync(join(paths.root, 'templates', 'pitfalls'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'pitfalls', 'code.md'), 'Stale async responses.\n')
    writeFileSync(
      join(paths.root, 'templates', 'pitfalls', 'tests.md'), 'clearAllMocks keeps implementations.\n',
    )
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const requirement = '[TEST] `src/shared.ts` lacks coverage for the empty input'
    await fakeForge.createIssue({
      title: requirement,
      body: buildIssueBody(requirement, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    expect(runnerStarts).toHaveLength(1)
    const spec = readFileSync(runnerStarts[0]!, 'utf8')
    expect(spec).toContain(requirement)
    expect(spec).toContain('clearAllMocks keeps implementations.')
    expect(spec).not.toContain('Stale async responses.')
  })

  it('does not claim from a poll whose duplicate re-read cannot be verified', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const description = '[BUG] `src/shared.ts` duplicate finding'
    await fakeForge.createIssue({
      title: description,
      body: buildIssueBody(description, 'scan-1'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const duplicate = await fakeForge.createIssue({
      title: description,
      body: buildIssueBody(description, 'scan-2'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const getIssue = fakeForge.getIssue.bind(fakeForge)
    fakeForge.getIssue = async (issueNumber) => {
      if (issueNumber === duplicate) throw new Error('duplicate re-read unavailable')
      return getIssue(issueNumber)
    }

    await expect(loop.poll()).resolves.toBe('continue')

    expect(runnerStarts).toEqual([])
    expect(logText()).toContain(
      'WARN issue queue unreachable: duplicate re-read unavailable',
    )
  })

  it('shows two review-origin fixes in the task log', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 2,
    })
    loop.initializeSessionStateForBranch()
    await Promise.all([
      fakeForge.createIssue({
        title: '[BUG] `src/first.ts` review finding',
        body: buildIssueBody(
          '[BUG] `src/first.ts` review finding', '20260808_000000_001_review-c1',
        ),
        labels: [LABEL_FINDING, LABEL_READY],
      }),
      fakeForge.createIssue({
        title: '[TEST] `src/second.ts` review finding',
        body: buildIssueBody(
          '[TEST] `src/second.ts` review finding', '20260808_000000_002_review-c2',
        ),
        labels: [LABEL_FINDING, LABEL_READY],
      }),
    ])

    await loop.poll()

    const claimed = logged.filter((line) => line.startsWith('Claimed'))
    expect(claimed).toHaveLength(2)
    expect(claimed.every((line) => /^Claimed \d{3}_fix\s/.test(line))).toBe(true)
    expect(logged.filter((line) => /^Started \d{3}_fix\s/.test(line))).toHaveLength(2)
  })

  it('returns every failed group member as singleton-ready work', async () => {
    useFakeRepository()
    let starts = 0
    const runner: Runner = {
      sharedSkills: fakeRunnerSharedSkills,
      start: async () => {
        if (starts++ > 0) throw new Error('do not restart during this test')
        return process.pid
      },
    }
    const loop = makeLoop(
      { issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1 },
      stubProject, undefined, undefined, runner,
    )
    loop.initializeSessionStateForBranch()
    const requirements = [
      '[BUG] `src/shared.ts` first grouped failure',
      '[TEST] `src/shared.ts` second grouped failure',
    ]
    const issueNumbers = await Promise.all(requirements.map((requirement) =>
      fakeForge.createIssue({
        title: requirement,
        body: buildIssueBody(requirement, 'scan-task'),
        labels: [LABEL_FINDING, LABEL_READY],
      })))

    await loop.poll()
    const failedTaskId = readdirSync(paths.statusDir)[0]!.replace(/\.json$/, '')
    writeRawStatus(failedTaskId, 'failed')
    await loop.poll()

    for (const issueNumber of issueNumbers) {
      const issue = await fakeForge.getIssue(issueNumber)
      expect(issue.labels).toContain(LABEL_GROUP_SINGLETON)
      expect(issue.labels).toContain(LABEL_READY)
      expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
      expect(issue.assignees).toEqual([])
    }
    expect(existsSync(join(paths.tasksDir, `${failedTaskId}.md`))).toBe(false)
    expect(logText()).toContain('grouped task failed')
  })

  it('returns a failed single-issue task to ready and drops its materialization', async () => {
    useFakeRepository()
    let starts = 0
    const runner: Runner = {
      sharedSkills: fakeRunnerSharedSkills,
      start: async () => {
        if (starts++ > 0) throw new Error('do not restart during this test')
        return process.pid
      },
    }
    const loop = makeLoop(
      { issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1 },
      stubProject, undefined, undefined, runner,
    )
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: '[BUG] `src/single.ts` single failure',
      body: buildIssueBody('[BUG] `src/single.ts` single failure', 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    await loop.poll()
    const failedTaskId = readdirSync(paths.statusDir)[0]!.replace(/\.json$/, '')
    writeRawStatus(failedTaskId, 'failed')
    await loop.poll()

    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_READY)
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(issue.assignees).toEqual([])
    expect(issueNumbersForTask(paths, failedTaskId)).toEqual([])
    expect(existsSync(join(paths.tasksDir, `${failedTaskId}.md`))).toBe(false)
  })

  it('parks a repeatedly failing issue and stops the loop at its retry bound', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
      maxIssueRetries: 1,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: '[BUG] `src/retry.ts` persistent failure',
      body: buildIssueBody('[BUG] `src/retry.ts` persistent failure', 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    await loop.poll()
    const failedTaskId = readdirSync(paths.statusDir)[0]!.replace(/\.json$/, '')
    writeRawStatus(failedTaskId, 'failed')
    expect(await loop.poll()).toBe('continue')

    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_RETRY_EXHAUSTED)
    expect(issue.labels).not.toContain(LABEL_READY)
    expect(issue.assignees).toEqual([])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toContain(`Parked #${issueNumber}`)
  })

  it('persists a failed-task release and stops after three failed reconciliations', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const description = '[BUG] `src/single.ts` retain an unreleasable failed task'
    const issueNumber = await fakeForge.createIssue({
      title: description,
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    await loop.poll()
    const failedTaskId = readdirSync(paths.statusDir)[0]!.replace(/\.json$/, '')
    writeRawStatus(failedTaskId, 'failed')
    const addLabel = fakeForge.addLabel.bind(fakeForge)
    fakeForge.addLabel = async (number, label) => {
      if (number === issueNumber && label === LABEL_READY) throw new Error('forge unavailable')
      await addLabel(number, label)
    }

    expect(await loop.poll()).toBe('continue')
    expect(readFileSync(join(paths.queueDir, 'issue-release-intent', failedTaskId), 'utf8'))
      .toBe(`${issueNumber}\n`)
    expect(readFileSync(join(paths.queueDir, 'issue-release-failure-count.txt'), 'utf8'))
      .toBe('1\n')

    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')

    expect(readFileSync(join(paths.queueDir, 'issue-release-failure-count.txt'), 'utf8'))
      .toBe('3\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toContain(
      `ERROR 3 consecutive issue release failures for #${issueNumber}; stopping the loop`,
    )
  })

  it('warns with the outsider login and leaves an untrusted issue unclaimed', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'outside finding',
      body: buildIssueBody('[BUG] `src/a.ts` asks for a change', 'outside'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const stored = fakeForge.issues.get(issueNumber)
    if (stored === undefined) throw new Error('expected outside issue')
    stored.author = { login: 'drive-by-user', hasWriteAccess: false }

    expect(await loop.poll()).toBe('continue')

    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.assignees).toEqual([])
    expect(issue.labels).toContain(LABEL_UNTRUSTED_AUTHOR)
    expect(logText()).toContain(
      `WARN issue #${issueNumber} by @drive-by-user is not trusted for execution; labeled ${LABEL_UNTRUSTED_AUTHOR}`,
    )
    expect(readdirSync(paths.tasksDir)).toEqual([])
    expect(logText()).not.toContain('Waiting remote')
  })

  it('skips an issue for the poll when its author permission could not be determined', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'maintainer finding',
      body: buildIssueBody('[BUG] `src/a.ts` asks for a change', 'maintainer'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const stored = fakeForge.issues.get(issueNumber)
    if (stored === undefined) throw new Error('expected maintainer issue')
    stored.author = { login: 'maintainer-one', hasWriteAccess: false, permissionLookupFailed: true }

    expect(await loop.poll()).toBe('continue')

    let issue = await fakeForge.getIssue(issueNumber)
    expect(issue.assignees).toEqual([])
    expect(issue.labels).not.toContain(LABEL_UNTRUSTED_AUTHOR)
    expect(logText()).toContain(
      `skipped issue #${issueNumber} this poll: write access of @maintainer-one could not be determined`,
    )
    expect(logText()).not.toContain('is not trusted for execution')
    expect(readdirSync(paths.tasksDir)).toEqual([])

    stored.author = { login: 'maintainer-one', hasWriteAccess: true }
    expect(await loop.poll()).toBe('continue')

    issue = await fakeForge.getIssue(issueNumber)
    expect(issue.labels).not.toContain(LABEL_UNTRUSTED_AUTHOR)
    expect(issue.assignees).not.toEqual([])
  })

  it('records an unparseable issue failure and stops with the issue quarantined', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'malformed finding', body: 'no generated structure',
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    const reason = `Issue #${issueNumber} cannot be materialized: missing \`## Requirement\` heading. Fix the issue body, remove loop:merge-failed, add loop:ready, unassign the worker, and restart the loop.`
    expect(readFileSync(join(paths.queueDir, 'decisions.txt'), 'utf8')).toBe(`${reason}\n`)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logged).toContain(`ERROR ${reason}`)
    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.labels).toContain('loop:merge-failed')
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(issue.assignees).toEqual(['worker-a'])
    expect(fakeForge.issueComments.get(issueNumber)).toContain(reason)
  })

  it('continues local refresh and queued work but defers unscanned merging when queue labels are unavailable', async () => {
    const completedTask = '20260811_120000_001_auto-completed'
    const failedTask = '20260811_120001_002_auto-failed'
    const queuedTask = '20260811_120002_003_auto-queued'
    useFakeRepository()
    makeFakeCompletedTask(completedTask)
    writeRawStatus(failedTask, 'running', null)
    writeFileSync(join(paths.tasksDir, `${queuedTask}.md`), '# queued spec\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), `${queuedTask}:0\n`)

    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    recordIssuesForTask(paths, completedTask, [17])
    fakeForge.listLabels = vi.fn().mockRejectedValue(new Error('forge unavailable'))

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, completedTask)?.status).toBe('completed')
    expect(existsSync(join(paths.queueDir, 'scanned', completedTask))).toBe(false)
    expect(logged).not.toContain('Merging 001_auto')
    expect(readStatus(paths, failedTask)?.status).toBe('failed')
    expect(logged).toContain(`FAILED: ${failedTask} — log: ${join(paths.logsDir, `${failedTask}.log`)}`)
    expect(runnerStarts).toEqual([join(paths.tasksDir, `${queuedTask}.md`)])
    expect(fakeForge.listOpenIssuesCalls).toEqual([])
    expect(fakeForge.issueComments.size).toBe(0)
  })

  it('keeps issue-backed queued work materialized when queue labels are unavailable', async () => {
    const taskId = '20260811_120003_004_auto-claimed'
    useFakeRepository()
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# claimed issue task\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), `${taskId}:2\n`)
    recordIssuesForTask(paths, taskId, [42])
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    fakeForge.listLabels = vi.fn().mockRejectedValue(new Error('forge unavailable'))

    expect(await loop.poll()).toBe('continue')

    expect(runnerStarts).toEqual([])
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe(`${taskId}:2\n`)
    expect(existsSync(join(paths.tasksDir, `${taskId}.md`))).toBe(true)
    expect(readStatus(paths, taskId)).toBeUndefined()
  })

  it('lists the shared loop issues once for an entire poll', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    await fakeForge.createIssue({
      title: 'pending repair', body: '', labels: [LABEL_FINDING, 'loop:merge-failed'],
    })

    await loop.poll()

    expect(fakeForge.listOpenIssuesCalls).toEqual([LABEL_FINDING])
  })

  it('does not re-read comments while an issue updatedAt is unchanged', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: true, autoMerge: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'pending repair', body: '', labels: [LABEL_FINDING, 'loop:merge-failed'],
    })

    await loop.poll()
    await loop.poll()

    expect(fakeForge.listIssueCommentsCalls).toEqual([issueNumber])
  })

  it('re-reads comments whose author permission could not be read', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: true, autoMerge: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'pending repair', body: '', labels: [LABEL_FINDING, 'loop:merge-failed'],
    })
    await fakeForge.commentIssue(issueNumber, 'MERGED: remote-task\nMerged elsewhere.')
    fakeForge.issueCommentAuthors.set(issueNumber, [
      { login: 'maintainer-one', hasWriteAccess: false, permissionLookupFailed: true },
    ])

    await loop.poll()
    await loop.poll()

    expect(fakeForge.listIssueCommentsCalls).toEqual([issueNumber, issueNumber])
  })

  it('defers forge calls until a long reported rate-limit reset and logs one wait', async () => {
    useFakeRepository()
    let current = new Date(2026, 7, 11, 14, 0, 0)
    const resetAt = new Date(2026, 7, 11, 14, 40, 0)
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 0,
    }, stubProject, undefined, () => current)
    loop.initializeSessionStateForBranch()
    const listOpenIssues = fakeForge.listOpenIssues.bind(fakeForge)
    let attempts = 0
    fakeForge.listOpenIssues = async (label) => {
      attempts += 1
      if (attempts === 1) throw new ForgeRateLimitError(resetAt)
      return listOpenIssues(label)
    }

    expect(await loop.poll()).toBe('continue')
    current = new Date(2026, 7, 11, 14, 30, 0)
    expect(await loop.poll()).toBe('continue')
    expect(attempts).toBe(1)
    expect(logged.filter((line) => line.startsWith('Waiting forge       rate limit until')))
      .toEqual(['Waiting forge       rate limit until 14:40'])

    current = resetAt
    expect(await loop.poll()).toBe('continue')
    expect(attempts).toBe(2)
    expect(logged.filter((line) => line.startsWith('Waiting forge       rate limit until')))
      .toHaveLength(1)
  })
})

describe('actionable findings', () => {
  it('filters format placeholders, literal and HTML-encoded, and keeps comparisons', () => {
    const loop = makeLoop()
    writeFinal('t1', [
      'NEXT_TASK: what to fix <and how>',
      'NEXT_TASK: &lt;description&gt;',
      'NEXT_TASK: [BUG] reject a value when count < 0 or count > maximum',
      'NEXT_TASK: [BUG] an ordinary finding',
    ].join('\n'))
    expect(loop.actionableFindings(finalMessageFile(paths, 't1'))).toEqual([
      '[BUG] reject a value when count < 0 or count > maximum',
      '[BUG] an ordinary finding',
    ])
  })

  it('reads only the final message, never the transcript', () => {
    const loop = makeLoop()
    writeFileSync(join(paths.logsDir, 't2.log'), 'NEXT_TASK: [BUG] a fixture in the transcript\n')
    writeFinal('t2', 'done\n')
    expect(loop.actionableFindings(finalMessageFile(paths, 't2'))).toEqual([])
  })

  it('ignores bare markers and trims a normal finding', () => {
    const loop = makeLoop()
    writeFinal('t3', [
      'NEXT_TASK:',
      'NEXT_TASK:   ',
      'NEXT_TASK:   [BUG] an ordinary finding   ',
    ].join('\n'))
    expect(loop.actionableFindings(finalMessageFile(paths, 't3'))).toEqual([
      '[BUG] an ordinary finding',
    ])
  })

  it('treats NO_FINDINGS as an explicit empty result', () => {
    const loop = makeLoop()
    writeFinal('t-no-findings', 'NO_FINDINGS\n')

    expect(loop.actionableFindings(finalMessageFile(paths, 't-no-findings'))).toEqual([])
    expect(logged).toEqual([])
  })

  it('keeps a real finding and warns when NO_FINDINGS contradicts it', () => {
    const loop = makeLoop()
    const finding = '[BUG] `src/search.ts` drops valid results'
    writeFinal('t-contradiction', `NO_FINDINGS\nNEXT_TASK: ${finding}\n`)

    expect(loop.actionableFindings(finalMessageFile(paths, 't-contradiction'))).toEqual([finding])
    expect(logText()).toContain('WARN final message has NO_FINDINGS and NEXT_TASK')
  })

  it('reads a NO_FINDINGS line in inline formatting as the marker', () => {
    const loop = makeLoop()
    const finding = '[BUG] `src/search.ts` drops valid results'
    writeFinal('t-formatted-no-findings', `\`NO_FINDINGS\`\nNEXT_TASK: ${finding}\n`)

    expect(loop.actionableFindings(finalMessageFile(paths, 't-formatted-no-findings')))
      .toEqual([finding])
    expect(logText()).toContain('WARN final message has NO_FINDINGS and NEXT_TASK')
  })

  it('does not read NO_FINDINGS inside a sentence as the marker', () => {
    const loop = makeLoop()
    const finding = '[BUG] `src/search.ts` drops valid results'
    writeFinal('t-prose-no-findings', `Print NO_FINDINGS when clean.\nNEXT_TASK: ${finding}\n`)

    expect(loop.actionableFindings(finalMessageFile(paths, 't-prose-no-findings')))
      .toEqual([finding])
    expect(logged).toEqual([])
  })

  it('ignores descriptions that only report no findings', () => {
    const loop = makeLoop()
    writeFinal('t4', [
      'NEXT_TASK: None.',
      'NEXT_TASK: None. Sections 5 and 6 found no actionable issues.',
      'NEXT_TASK: None for sections 5-6.',
      'NEXT_TASK: Sections 5 and 6 found no actionable issues',
      'NEXT_TASK: nothing to report',
    ].join('\n'))
    expect(loop.actionableFindings(finalMessageFile(paths, 't4'))).toEqual([])
  })

  it('warns and ignores a finding whose description cannot produce a task slug', () => {
    const loop = makeLoop()
    const finding = '[!!!]'
    writeFinal('t-empty-slug', `NEXT_TASK: ${finding}\n`)

    expect(loop.actionableFindings(finalMessageFile(paths, 't-empty-slug'))).toEqual([])
    expect(logText()).toContain(`WARN ignored finding with an empty slug: ${finding}`)
  })

  it('keeps a normal English finding after applying the slug guard', () => {
    const loop = makeLoop()
    const finding = '[BUG] `src/search.ts` mishandles an empty response'
    writeFinal('t-english-slug', `NEXT_TASK: ${finding}\n`)

    expect(loop.actionableFindings(finalMessageFile(paths, 't-english-slug'))).toEqual([finding])
  })

  it('filters a finding that opens with None even when the remainder sounds actionable', () => {
    const loop = makeLoop()
    writeFinal('t-none-prefix', 'NEXT_TASK: None of the export rows carry ids\n')
    expect(loop.actionableFindings(finalMessageFile(paths, 't-none-prefix'))).toEqual([])
  })

  it('keeps findings that describe incorrect no-issue behavior', () => {
    const loop = makeLoop()
    const finding = '[BUG] SearchPage reports no issues when the request fails'
    writeFinal('t-no-issues-bug', `NEXT_TASK: ${finding}\n`)
    expect(loop.actionableFindings(finalMessageFile(paths, 't-no-issues-bug'))).toEqual([finding])
  })

  it('keeps a real finding that contains None', () => {
    const loop = makeLoop()
    const findings = [
      '[BUG] `src/x.ts` returns None instead of an empty list',
      '[TEST] `src/a.ts` covers the None branch',
    ]
    writeFinal('t5', findings.map((finding) => `NEXT_TASK: ${finding}`).join('\n'))
    expect(loop.actionableFindings(finalMessageFile(paths, 't5'))).toEqual(findings)
  })
})

describe('CI check normalization (forge adapter)', () => {
  it('reads completed successes as success', () => {
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('success')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipped')
  })
  it('reads an in-progress check with an empty conclusion as pending, never success', () => {
    expect(normalizeEntry({ status: 'IN_PROGRESS', conclusion: '' })).toBe('pending')
  })
  it('reads a completed check with an empty conclusion as pending', () => {
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: '' })).toBe('pending')
  })
  it('reads terminal unsuccessful conclusions as failure', () => {
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'STALE' })).toBe('failure')
  })
  it('reads a StatusContext by its state and the unclassifiable as pending', () => {
    expect(normalizeEntry({ state: 'SUCCESS' })).toBe('success')
    expect(normalizeEntry({ state: '' })).toBe('pending')
    expect(normalizeEntry({})).toBe('pending')
  })
})

describe('checkPrCiStatus', () => {
  let headSha: string

  beforeEach(() => {
    headSha = initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'pr-url.txt'), 'https://example.test/pull/1\n')
  })

  it('compares reordered check names afresh after the head changes', async () => {
    const loop = makeLoop()
    setForgeStatus({
      ...forgeStatus,
      state: 'closed',
      headSha: 'f'.repeat(40),
      checks: [
        { name: 'a', conclusion: 'success', startedAt: '' },
        { name: 'b', conclusion: 'success', startedAt: '' },
      ],
    })
    expect(await loop.checkPrCiStatus()).toBe('pending')

    setForgeStatus({
      ...forgeStatus,
      headSha: 'e'.repeat(40),
      checks: [
        { name: 'b', conclusion: 'success', startedAt: '' },
        { name: 'a', conclusion: 'success', startedAt: '' },
      ],
    })
    expect(await loop.checkPrCiStatus()).toBe('pending')
    expect(await loop.checkPrCiStatus()).toBe('success')
  })

  it('judges a closed PR by its checks even when its head is not the local HEAD', async () => {
    const loop = makeLoop()
    setForgeStatus({
      ...forgeStatus,
      state: 'closed',
      headSha: 'f'.repeat(40),
      checks: [{ name: 'a', conclusion: 'failure', startedAt: '' }],
    })
    expect(await loop.checkPrCiStatus()).toBe('pending')
    expect(await loop.checkPrCiStatus()).toBe('failure')
  })

  it('treats a merged PR as passed', async () => {
    const loop = makeLoop()
    setForgeStatus({ ...forgeStatus, state: 'merged' })
    expect(await loop.checkPrCiStatus()).toBe('success')
  })

  it('reports repeated status errors and stops the loop', async () => {
    const loop = makeLoop()
    fakeForge.prStatus = async () => { throw new Error('checks unavailable') }

    expect(await loop.checkPrCiStatus()).toBe('unknown')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(await loop.checkPrCiStatus()).toBe('unknown')

    expect(logText()).toContain('WARN could not check PR CI status: checks unavailable')
    expect(logText()).toContain(
      'ERROR could not check PR CI status: checks unavailable (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })
})
