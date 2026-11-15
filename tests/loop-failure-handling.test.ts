import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import { loadConfig } from '../src/config.ts'
import {
  buildIssueBody, issueNumbersForTask, LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_READY,
} from '../src/issueQueue.ts'
import { existingTaskIdForDesc } from '../src/ids.ts'
import { createLoop } from '../src/loop.ts'
import { statusFile, worktreeDir } from '../src/paths.ts'
import { recordTaskProcess } from '../src/processRegistry.ts'
import { refreshAll } from '../src/refresh.ts'
import { readStatus } from '../src/status.ts'
import { StartupProcessRetainedError, startTask } from '../src/start.ts'
import { enqueueTask, specFile } from '../src/tasks.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import {
  fakeForge, forgeStatus, git, initializeGitRepo, initializeGitRepoWithRemote, logText,
  logged, makeLoop, makeRunner, paths, registerLoopHooks, repoRoot, runnerStarts,
  setForgeStatus, setLogged, stubProject, writeRawStatus,
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

describe('failure announcement and burst stop (via poll)', () => {
  it('reports an idle poll with its wait target', async () => {
    const loop = makeLoop({ scanEnabled: false, maxScanCycles: 6 })

    expect(await loop.poll()).toBe('continue')
    expect(logText()).toMatch(
      /^Idle Status      Task=\d+  Queue=\d+  0s  Waiting=pull request promotion$/m,
    )
  })

  it('ages and backs off idle status lines, then resets when work appears', async () => {
    let current = new Date('2026-08-08T03:00:00Z')
    const loop = makeLoop(
      { scanEnabled: false, autoPr: false, issueQueueEnabled: true, maxScanCycles: 6 },
      stubProject,
      undefined,
      () => current,
    )
    fakeForge.listOpenIssues = async () => { throw new Error('remote status unavailable') }
    const idleLines: Array<{ at: number; line: string }> = []

    for (let poll = 0; poll <= 60; poll += 1) {
      current = new Date(Date.parse('2026-08-08T03:00:00Z') + poll * 30_000)
      const before = logged.length
      expect(await loop.poll()).toBe('continue')
      const status = logged.slice(before).find((line) => line.startsWith('Idle '))
      if (status !== undefined) idleLines.push({ at: current.getTime(), line: status })
    }

    expect(idleLines).toHaveLength(10)
    expect(idleLines.at(-1)?.line).toContain('30m')
    for (let index = 1; index < idleLines.length; index += 1) {
      expect(idleLines[index]!.at - idleLines[index - 1]!.at)
        .toBeLessThanOrEqual(5 * 60_000)
    }

    const taskId = '20260808_033030_001_auto-new-work'
    writeRawStatus(taskId, 'running', process.pid)
    current = new Date('2026-08-08T03:30:30Z')
    const activeStart = logged.length
    await loop.poll()
    current = new Date('2026-08-08T03:31:00Z')
    await loop.poll()
    expect(logged.slice(activeStart).filter((line) => line.startsWith('Running ')))
      .toEqual([
        'Running Status      Task=1  Queue=0',
        'Running Status      Task=1  Queue=0',
      ])

    rmSync(statusFile(paths, taskId))
    current = new Date('2026-08-08T03:31:30Z')
    await loop.poll()
    expect(logged.at(-1)).toBe(
      'Idle Status      Task=0  Queue=0  0s  Waiting=finding status',
    )
  })

  it('omits Waiting while a scan is in flight', async () => {
    const loop = makeLoop({ scanEnabled: false })
    writeRawStatus('20260809_000000_001_scan', 'running', process.pid)

    expect(await loop.poll()).toBe('continue')
    expect(logged).toContain('Running Status      Scan=1  Task=0  Queue=0')
    expect(logged).not.toContain('Waiting=')
  })

  it('reports both phase groups when scans and tasks run together', async () => {
    const loop = makeLoop({ scanEnabled: false })
    writeRawStatus('20260809_000000_001_scan', 'running', process.pid)
    writeRawStatus('20260809_000001_002_auto-fix', 'running', process.pid)

    expect(await loop.poll()).toBe('continue')
    expect(logged).toContain('Running Status      Scan=1  Task=1  Queue=0')
    expect(logged).not.toContain('Waiting=')
  })

  it('announces a failure once, records it for the cycle, and stops on a burst', async () => {
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 3 })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
    for (const taskId of ['f1', 'f2', 'f3']) {
      writeRawStatus(taskId, 'running', null)
    }

    expect(await loop.poll()).toBe('continue')
    for (const taskId of ['f1', 'f2', 'f3']) {
      expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`)
      expect(logText()).toContain(`Failed ${taskId.padEnd(12)}log ${taskId}.log`)
    }
    const failedRecord = readFileSync(join(paths.queueDir, 'failed-4'), 'utf8')
    expect(failedRecord.trim().split('\n')).toHaveLength(3)
    expect(logText()).toContain('ERROR 3 tasks failed in one poll; stopping for environment repair')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)

    // The next poll consumes the stop and exits; the failures are not announced again.
    setLogged([])
    expect(await loop.poll()).toBe('stopped')
    expect(logText()).not.toContain('Failed f1')
    expect(readFileSync(join(paths.queueDir, 'failed-4'), 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('stops and fails a task that outlives its deadline', async () => {
    // A PID no test process owns, answered as a live runner whose identity still matches.
    const pid = process.pid + 1_000_000
    const taskId = '20260808_030000_001_auto-stuck'
    const spies = [
      vi.spyOn(operatingSystem, 'processStartIdentity')
        .mockImplementation((probed) => (probed === pid ? 'stuck-start' : undefined)),
      vi.spyOn(operatingSystem, 'processIsAlive').mockImplementation((probed) => probed === pid),
    ]
    let treeAlive = true
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree')
      .mockImplementation(() => {
        treeAlive = false
        return true
      })
    spies.push(terminate, vi.spyOn(operatingSystem, 'processTreeIsAlive')
      .mockImplementation((probed) => probed === pid && treeAlive))
    try {
      writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
      writeRawStatus(taskId, 'running', pid)
      const loop = makeLoop(
        { autoMerge: false, scanEnabled: false, taskDeadlineHours: 4 }, stubProject, undefined,
        () => new Date('2026-08-08T07:00:00Z'),
      )

      expect(await loop.poll()).toBe('continue')

      expect(terminate).toHaveBeenCalledWith(pid)
      expect(readStatus(paths, taskId)?.status).toBe('failed')
      expect(logText()).toContain(
        `Stopped 001_auto    process tree PID ${pid} after the 4-hour task deadline`)
      expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`)
      expect(readFileSync(join(paths.logsDir, `${taskId}.log`), 'utf8'))
        .toContain('Task deadline exceeded: running since 2026-08-08T03:00:00Z')
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })

  it('does not count tasks already dead at daemon startup as a failure burst', async () => {
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
    for (const taskId of ['old-f1', 'old-f2', 'old-f3']) {
      writeRawStatus(taskId, 'running', null)
    }
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 3 })

    expect(await loop.poll()).toBe('continue')

    for (const taskId of ['old-f1', 'old-f2', 'old-f3']) {
      expect(readStatus(paths, taskId)?.status).toBe('failed')
      expect(logged).toContain(
        `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`,
      )
    }
    expect(readFileSync(join(paths.queueDir, 'failed-4'), 'utf8').trim().split('\n'))
      .toHaveLength(3)
    expect(logText()).not.toContain('tasks failed in one poll')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    for (const taskId of ['old-f1', 'old-f2', 'old-f3']) {
      rmSync(join(paths.queueDir, 'scanned', `${taskId}.failed`))
      writeRawStatus(taskId, 'running', null)
    }
    setLogged([])

    expect(await loop.poll()).toBe('continue')
    expect(logText()).toContain('ERROR 3 tasks failed in one poll; stopping for environment repair')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })

  it('does not count tasks refreshed by status between a stop and a restart as a burst', async () => {
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
    const taskIds = ['stopped-f1', 'stopped-f2', 'stopped-f3']
    for (const taskId of taskIds) writeRawStatus(taskId, 'running', null)

    // `status` run while no daemon holds the queue, as after a graceful stop.
    await refreshAll(paths, { daemonOwnsQueue: false })
    for (const taskId of taskIds) expect(readStatus(paths, taskId)?.status).toBe('running')

    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 3 })
    expect(await loop.poll()).toBe('continue')

    for (const taskId of taskIds) {
      expect(readStatus(paths, taskId)?.status).toBe('failed')
      expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`)
    }
    expect(logText()).not.toContain('tasks failed in one poll')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('does not count tasks already failed at daemon startup as a failure burst', async () => {
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
    const taskIds = ['pre-f1', 'pre-f2', 'pre-f3']
    for (const taskId of taskIds) writeRawStatus(taskId, 'failed')
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 3 })

    expect(await loop.poll()).toBe('continue')

    for (const taskId of taskIds) {
      expect(logged.filter((line) =>
        line === `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`))
        .toHaveLength(1)
    }
    expect(readFileSync(join(paths.queueDir, 'failed-4'), 'utf8').trim().split('\n'))
      .toEqual(taskIds)
    expect(logText()).not.toContain('tasks failed in one poll')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    setLogged([])
    expect(await loop.poll()).toBe('continue')
    expect(logged.some((line) => line.startsWith('FAILED:'))).toBe(false)
  })

  it('still stops on a burst of fresh failures beside tasks failed at startup', async () => {
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
    for (const taskId of ['pre-f1', 'pre-f2', 'pre-f3']) writeRawStatus(taskId, 'failed')
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 3 })

    expect(await loop.poll()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    for (const taskId of ['new-f1', 'new-f2', 'new-f3']) writeRawStatus(taskId, 'running', null)
    setLogged([])

    expect(await loop.poll()).toBe('continue')
    expect(logText()).toContain('ERROR 3 tasks failed in one poll; stopping for environment repair')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })

  it('does not announce a startup failure already listed as announced', async () => {
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeRawStatus('listed-f1', 'failed')
    writeRawStatus('unlisted-f1', 'failed')
    writeFileSync(join(paths.queueDir, 'announced-failures.txt'), 'listed-f1\n')
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 1 })

    expect(await loop.poll()).toBe('continue')

    expect(logged.some((line) => line.startsWith('FAILED: listed-f1'))).toBe(false)
    expect(logged).toContain(
      `FAILED: unlisted-f1 — log: ${join(paths.logsDir, 'unlisted-f1.log')}`)
    expect(readFileSync(join(paths.queueDir, 'failed-1'), 'utf8')).toBe('unlisted-f1\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('announces a re-enqueued task that fails a second time', async () => {
    // A branch named `task` blocks every `task/<id>` branch, so worktree creation fails
    // and leaves neither worktree nor branch for cleanup to remove.
    initializeGitRepoWithRemote()
    git(['branch', 'task'])
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const taskId = '20260808_120000_001_user-retry'
    writeFileSync(specFile(paths, taskId), '# retry\n')
    const failedLine = `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`
    // A task still running keeps the cycle open across the polls below.
    writeRawStatus('20260808_110000_000_user-busy', 'running', process.pid)
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxParallel: 2, maxBurstFailures: 3 })
    loop.initializeSessionStateForBranch()

    expect(enqueueTask(paths, taskId).outcome).toBe('enqueued')
    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')
    expect(readStatus(paths, taskId)?.status).toBe('failed')
    expect(logged.filter((line) => line === failedLine)).toHaveLength(1)

    expect(enqueueTask(paths, taskId).outcome).toBe('enqueued')
    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('failed')
    expect(logged.filter((line) => line === failedLine)).toHaveLength(2)
    expect(readFileSync(join(paths.queueDir, 'failed-1'), 'utf8')).toBe(`${taskId}\n${taskId}\n`)
    expect(existsSync(join(paths.queueDir, 'scanned', `${taskId}.failed`))).toBe(true)
  })

  it('announces a retry of a failure the previous run announced', async () => {
    initializeGitRepoWithRemote()
    git(['branch', 'task'])
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const taskId = '20260808_120000_001_user-listed'
    writeFileSync(specFile(paths, taskId), '# listed\n')
    writeRawStatus(taskId, 'failed')
    writeFileSync(join(paths.queueDir, 'announced-failures.txt'), `${taskId}\nother-f1\n`)
    const failedLine = `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`
    // A task still running keeps the cycle open across the polls below.
    writeRawStatus('20260808_110000_000_user-busy', 'running', process.pid)
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxParallel: 2, maxBurstFailures: 3 })
    loop.initializeSessionStateForBranch()

    expect(await loop.poll()).toBe('continue')
    expect(logged.some((line) => line.startsWith('FAILED:'))).toBe(false)

    expect(enqueueTask(paths, taskId).outcome).toBe('enqueued')
    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')

    expect(logged.filter((line) => line === failedLine)).toHaveLength(1)
    expect(readFileSync(join(paths.queueDir, 'announced-failures.txt'), 'utf8')).toBe('other-f1\n')
  })

  it('releases and counts the issue of a task already failed at startup', async () => {
    initializeGitRepo()
    // The released issue is ready again, so the restarted loop may claim it anew.
    const runner = makeRunner()
    const config = {
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
      maxBurstFailures: 1,
    }
    const first = makeLoop(config, stubProject, undefined, undefined, runner)
    first.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: '[BUG] `src/stale.ts` failure before restart',
      body: buildIssueBody('[BUG] `src/stale.ts` failure before restart', 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    await first.poll()
    const failedTaskId = readdirSync(paths.statusDir)[0]!.replace(/\.json$/, '')
    writeRawStatus(failedTaskId, 'failed')
    setLogged([])

    // A restarted daemon meets the same forge, so it reuses the first loop's fake.
    const forge = fakeForge
    const next = createLoop({
      paths,
      config: { ...loadConfig({}), taskDeadlineHours: 0, ...config },
      forge,
      runner,
      project: stubProject,
      log: (line) => logged.push(line),
      now: () => new Date(2026, 7, 8, 12, 0, 0),
    })
    expect(await next.poll()).toBe('continue')

    expect(logged).toContain(
      `FAILED: ${failedTaskId} — log: ${join(paths.logsDir, `${failedTaskId}.log`)}`)
    expect(logText()).toContain('grouped task failed')
    expect(issueNumbersForTask(paths, failedTaskId)).toEqual([])
    expect(readFileSync(join(paths.queueDir, 'issue-failure-count', String(issueNumber)), 'utf8'))
      .toBe('1\n')
    expect(logText()).not.toContain('tasks failed in one poll')
  })

  it('neither announces nor counts failures left by a finished run', async () => {
    initializeGitRepoWithRemote()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const finished = makeLoop({
      scanEnabled: false, autoPr: true, reviewEnabled: false, maxBurstFailures: 4,
    })
    finished.initializeSessionStateForBranch()
    fakeForge.markPrReady = async () => {
      setForgeStatus({ ...forgeStatus, isDraft: false })
    }
    const taskIds = ['old-f1', 'old-f2', 'old-f3']
    for (const taskId of taskIds) writeRawStatus(taskId, 'failed')

    expect(await finished.poll()).toBe('done')
    for (const taskId of taskIds) {
      expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`)
      expect(readStatus(paths, taskId)?.status).toBe('failed')
    }
    expect(existsSync(join(paths.queueDir, 'scanned', 'old-f1.failed'))).toBe(false)

    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const next = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 3 })
    setLogged([])

    expect(await next.poll()).toBe('continue')
    expect(logged.some((line) => line.startsWith('FAILED:'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'failed-1'))).toBe(false)
    expect(logText()).not.toContain('tasks failed in one poll')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('records a failed scan in its cycle before entering the cycle gate', async () => {
    const taskId = '20260809_000000_001_scan'
    const loop = makeLoop({
      autoPr: false,
      reviewEnabled: true,
      autoReview: false,
    })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeRawStatus(taskId, 'failed')

    expect(await loop.poll()).toBe('continue')

    expect(readFileSync(join(paths.queueDir, 'failed-1'), 'utf8')).toBe(`${taskId}\n`)
    expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`)
    expect(logged).toContain('CYCLE_COMPLETE: 1/3')
    expect(logged.indexOf(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`))
      .toBeLessThan(logged.indexOf('CYCLE_COMPLETE: 1/3'))
  })

  it('invalidates a completed cycle gate when a new task failure is observed', async () => {
    const taskId = '20260809_000001_002_auto-late-failure'
    const loop = makeLoop({
      autoPr: false,
      reviewEnabled: true,
      autoReview: false,
    })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-1'), '')
    writeRawStatus(taskId, 'failed')

    expect(await loop.poll()).toBe('continue')

    const lossNote = `Cycle 1 lost 1 task(s) to failure, so their findings are not in this branch: ${taskId}`
    expect(readFileSync(join(paths.queueDir, 'decisions.txt'), 'utf8')).toBe(`${lossNote}\n`)
    expect(logged).toContain('CYCLE_COMPLETE: 1/3')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
  })

  it('does not start queued work or scans while a stop is pending', async () => {
    const loop = makeLoop({ autoMerge: false, scanEnabled: true, maxBurstFailures: 1 })
    writeRawStatus('f1', 'running', null)
    writeFileSync(join(paths.tasksDir, 'queued-task.md'), '# spec\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), 'queued-task:0\n')

    await loop.poll()
    expect(runnerStarts).toHaveLength(0)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toContain('queued-task')
  })

  it('requeues a local task when startup fails before a status can be persisted', async () => {
    initializeGitRepo()
    const taskId = '20260809_000002_003_auto-invalid-effort'
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxParallel: 1 })
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
    mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'effort', taskId), 'impossible\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), `${taskId}:2\n`)

    expect(await loop.poll()).toBe('continue')

    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe(`${taskId}:2\n`)
    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(runnerStarts).toHaveLength(0)
    expect(logText()).toContain("startup failed: effort must be minimal, low, medium or high")

    expect(await loop.poll()).toBe('continue')

    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe(`${taskId}:2\n`)
    expect(logText()).toContain(
      "ERROR 003_auto startup failed: effort must be minimal, low, medium or high, got 'impossible' (repeated 2 times)",
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })

  it('stops cleanly when a statusless startup failure cannot be requeued', async () => {
    initializeGitRepo()
    const taskId = '20260809_000003_004_auto-missing-spec'
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxParallel: 1 })
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'backlog.txt'), `${taskId}:1\n`)

    await expect(loop.poll()).resolves.toBe('continue')

    expect(runnerStarts).toHaveLength(0)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toContain(
      'ERROR 004_auto startup failed: Task specification not found:',
    )
    expect(logText()).toContain('; could not requeue: Task specification not found:')
  })

  it('releases a claimed issue immediately when task startup fails', async () => {
    initializeGitRepo()
    const description = '[BUG] recover a claimed task after startup fails'
    const attemptedTaskIds: string[] = []
    let attempt = 0
    const runner: Runner = {
      sharedSkills: fakeRunnerSharedSkills,
      start: async (options) => {
        attemptedTaskIds.push(options.specFile.replace(/^.*[\\/]/, '').replace(/\.md$/, ''))
        if (attempt++ === 0) throw new Error('runner spawn failed')
        return process.pid
      },
    }
    const loop = makeLoop(
      { issueQueueEnabled: true, scanEnabled: false, maxParallel: 1 },
      stubProject,
      undefined,
      () => new Date(2026, 7, 8, 12, 0, 0),
      runner,
    )
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'startup recovery',
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    const firstTaskId = attemptedTaskIds[0]!
    const released = await fakeForge.getIssue(issueNumber)
    expect(released.labels).toContain(LABEL_READY)
    expect(released.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(released.assignees).toEqual([])
    expect(logged).toContain('Released 001_auto    startup failed')
    expect(existsSync(join(paths.tasksDir, `${firstTaskId}.md`))).toBe(false)
    expect(existsSync(statusFile(paths, firstTaskId))).toBe(false)
    expect(existsSync(worktreeDir(paths, firstTaskId))).toBe(false)
    expect(existingTaskIdForDesc(paths, 'auto', description)).toBeUndefined()

    expect(await loop.poll()).toBe('continue')

    expect(attemptedTaskIds).toHaveLength(2)
    expect(attemptedTaskIds[1]).not.toBe(firstTaskId)
    const reclaimed = await fakeForge.getIssue(issueNumber)
    expect(reclaimed.labels).toContain(LABEL_IN_PROGRESS)
    expect(reclaimed.labels).not.toContain(LABEL_READY)
    expect(reclaimed.assignees).toEqual(['worker-a'])
  })

  it('stops without releasing or retrying a claimed task whose startup process survives', async () => {
    initializeGitRepo()
    const description = '[BUG] retain work owned by a surviving startup process'
    const retainedPid = process.pid
    const retainedStarts: string[] = []
    const retainStartup: typeof startTask = async (startPaths, _runner, taskId) => {
      retainedStarts.push(taskId)
      recordTaskProcess(startPaths, taskId, retainedPid)
      throw new StartupProcessRetainedError(
        retainedPid,
        new Error('status persistence failed'),
        new Error('process tree survived'),
      )
    }
    const loop = makeLoop(
      { issueQueueEnabled: true, scanEnabled: false, maxParallel: 1 },
      stubProject,
      undefined,
      () => new Date(2026, 7, 8, 12, 0, 0),
      makeRunner(),
      enqueueTask,
      undefined,
      retainStartup,
    )
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'retained startup process',
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    const taskId = retainedStarts[0]!
    const retained = await fakeForge.getIssue(issueNumber)
    expect(retained.labels).toContain(LABEL_IN_PROGRESS)
    expect(retained.labels).not.toContain(LABEL_READY)
    expect(retained.assignees).toEqual(['worker-a'])
    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(existsSync(join(paths.tasksDir, `${taskId}.md`))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toContain(
      `startup process tree PID ${retainedPid} survived; task retained and loop stopped`,
    )

    expect(await loop.poll()).toBe('stopped')
    expect(retainedStarts).toEqual([taskId])
  })

  it('stops without releasing a claim when the runner returns an invalid PID', async () => {
    initializeGitRepo()
    const description = '[BUG] retain a claimed task with unknown runner ownership'
    const attemptedTaskIds: string[] = []
    const runner: Runner = {
      sharedSkills: fakeRunnerSharedSkills,
      start: async (options) => {
        attemptedTaskIds.push(options.specFile.replace(/^.*[\\/]/, '').replace(/\.md$/, ''))
        return 0
      },
    }
    const loop = makeLoop(
      { issueQueueEnabled: true, scanEnabled: false, maxParallel: 1 },
      stubProject,
      undefined,
      () => new Date(2026, 7, 8, 12, 0, 0),
      runner,
    )
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'unknown runner ownership',
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    const taskId = attemptedTaskIds[0]!
    const retained = await fakeForge.getIssue(issueNumber)
    expect(retained.labels).toContain(LABEL_IN_PROGRESS)
    expect(retained.labels).not.toContain(LABEL_READY)
    expect(retained.assignees).toEqual(['worker-a'])
    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(existsSync(worktreeDir(paths, taskId))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toContain(
      'runner returned an invalid PID; task ownership is unknown, task retained and loop stopped',
    )

    expect(await loop.poll()).toBe('stopped')
    expect(attemptedTaskIds).toEqual([taskId])
  })

  it('persists a startup-failure release and stops after three failed reconciliations', async () => {
    initializeGitRepo()
    const description = '[BUG] retain a claimed task until its issue can be released'
    const attemptedTaskIds: string[] = []
    const runner: Runner = {
      sharedSkills: fakeRunnerSharedSkills,
      start: async (options) => {
        attemptedTaskIds.push(options.specFile.replace(/^.*[\\/]/, '').replace(/\.md$/, ''))
        throw new Error('runner spawn failed')
      },
    }
    const loop = makeLoop(
      { issueQueueEnabled: true, scanEnabled: false, maxParallel: 1 },
      stubProject,
      undefined,
      () => new Date(2026, 7, 8, 12, 0, 0),
      runner,
    )
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'failed release recovery',
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const addLabel = fakeForge.addLabel.bind(fakeForge)
    fakeForge.addLabel = async (number, label) => {
      if (number === issueNumber && label === LABEL_READY) throw new Error('forge unavailable')
      await addLabel(number, label)
    }

    expect(await loop.poll()).toBe('continue')

    const taskId = attemptedTaskIds[0]!
    const issue = await fakeForge.getIssue(issueNumber)
    expect(attemptedTaskIds).toHaveLength(1)
    expect(issue.labels).toContain(LABEL_IN_PROGRESS)
    expect(issue.labels).not.toContain(LABEL_READY)
    expect(issue.assignees).toEqual([])
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe('')
    expect(existsSync(join(paths.tasksDir, `${taskId}.md`))).toBe(true)
    expect(existsSync(statusFile(paths, taskId))).toBe(true)
    expect(existsSync(worktreeDir(paths, taskId))).toBe(true)
    expect(existingTaskIdForDesc(paths, 'auto', description)).toBe(taskId)
    expect(readFileSync(join(paths.queueDir, 'issue-release-intent', taskId), 'utf8'))
      .toBe(`${issueNumber}\n`)
    expect(readFileSync(join(paths.queueDir, 'issue-release-failure-count.txt'), 'utf8'))
      .toBe('1\n')

    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')

    expect(attemptedTaskIds).toHaveLength(1)
    expect(readFileSync(join(paths.queueDir, 'issue-release-failure-count.txt'), 'utf8'))
      .toBe('3\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toContain(
      `ERROR 3 consecutive issue release failures for #${issueNumber}; stopping the loop`,
    )
  })

  it('counts a startup failure once while its issue release is still pending', async () => {
    initializeGitRepo()
    const description = '[BUG] count a startup failure once across release retries'
    const attemptedTaskIds: string[] = []
    const runner: Runner = {
      sharedSkills: fakeRunnerSharedSkills,
      start: async (options) => {
        attemptedTaskIds.push(options.specFile.replace(/^.*[\\/]/, '').replace(/\.md$/, ''))
        throw new Error('runner spawn failed')
      },
    }
    const loop = makeLoop(
      { issueQueueEnabled: true, scanEnabled: false, maxParallel: 1 },
      stubProject,
      undefined,
      () => new Date(2026, 7, 8, 12, 0, 0),
      runner,
    )
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'single failure count',
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const addLabel = fakeForge.addLabel.bind(fakeForge)
    fakeForge.addLabel = async (number, label) => {
      if (number === issueNumber && label === LABEL_READY) throw new Error('forge unavailable')
      await addLabel(number, label)
    }
    const failureCountFile = join(paths.queueDir, 'issue-failure-count', String(issueNumber))

    expect(await loop.poll()).toBe('continue')

    const taskId = attemptedTaskIds[0]!
    expect(readStatus(paths, taskId)?.status).toBe('failed')
    expect(readFileSync(failureCountFile, 'utf8')).toBe('1\n')

    expect(await loop.poll()).toBe('continue')

    expect(attemptedTaskIds).toEqual([taskId])
    expect(readFileSync(failureCountFile, 'utf8')).toBe('1\n')
  })
})

describe('noteMergeFailure', () => {
  const mergeLog = (): string => join(paths.logsDir, 'sample.merge.log')
  const stopFile = (): string => join(paths.queueDir, 'stop')

  it('uses the project infrastructure diagnosis, counts to the limit, and stops', () => {
    const infrastructureProject: ProjectAdapter = {
      ...stubProject,
      classifyInfrastructureFailure: (output) => output.includes('fixture service unavailable')
        ? {
            diagnosis: 'the fixture service is unavailable, and the integration tests need it',
            remediation: 'restart the fixture service and restart the loop',
          }
        : undefined,
    }
    const loop = makeLoop({ maxConsecutiveMergeFailures: 3 }, infrastructureProject)
    writeFileSync(mergeLog(), 'fixture service unavailable\n')
    loop.noteMergeFailure(mergeLog())
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('1')
    expect(logText()).toContain('the fixture service is unavailable')
    expect(existsSync(stopFile())).toBe(false)

    loop.noteMergeFailure(mergeLog())
    expect(existsSync(stopFile())).toBe(false)
    loop.noteMergeFailure(mergeLog())
    expect(existsSync(stopFile())).toBe(true)
    expect(logText()).toContain('ERROR 3 consecutive merge failures; stopping the loop')
  })

  it('restarts the count after a successful merge cleared it', () => {
    const loop = makeLoop({ maxConsecutiveMergeFailures: 3 })
    writeFileSync(mergeLog(), 'whatever\n')
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '0\n')
    loop.noteMergeFailure(mergeLog())
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('1')
    expect(existsSync(stopFile())).toBe(false)
  })

  it('does not blame the environment for an ordinary test failure', () => {
    const loop = makeLoop()
    writeFileSync(mergeLog(), 'Tests run: 4, Failures: 1\nTests failed. Aborting merge.\n')
    loop.noteMergeFailure(mergeLog())
    expect(logText()).not.toMatch(/fixture service is unavailable|unreachable/)
  })

  it('delegates toolchain-specific registry failures to the project adapter', () => {
    const mavenProject: ProjectAdapter = {
      ...stubProject,
      classifyInfrastructureFailure: (output) => output.includes('Could not transfer artifact')
        ? {
            diagnosis: 'the Maven repository is unreachable',
            remediation: 'restore access to the Maven repository and restart the loop',
          }
        : undefined,
    }
    const loop = makeLoop({}, mavenProject)
    writeFileSync(mergeLog(), 'Could not transfer artifact org.example:thing from central\n')
    loop.noteMergeFailure(mergeLog())
    expect(logText()).toContain('the Maven repository is unreachable')
  })

  it('does not classify a toolchain-specific registry failure without an adapter rule', () => {
    const loop = makeLoop()
    writeFileSync(mergeLog(), 'Could not transfer artifact org.example:thing from central\n')
    loop.noteMergeFailure(mergeLog())
    expect(logText()).not.toContain('unreachable')
  })
})

describe('runCycleSuite', () => {
  const stopFile = (): string => join(paths.queueDir, 'stop')

  it('is a no-op under full task gates', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Marker', cwd: '',
        command: `node -e "require('node:fs').writeFileSync('suite-ran', '')"`,
      }],
    }
    const loop = makeLoop({ taskGate: 'full' }, suiteProject)
    expect(loop.runCycleSuite(1)).toBe(true)
    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(false)
  })

  it('runs only opted-in project suite steps under full task gates', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [
        {
          label: 'Light only', cwd: '',
          command: `node -e "require('node:fs').writeFileSync('light-suite-ran', '')"`,
        },
        {
          label: 'Every gate', cwd: '', runAtEveryTaskGate: true,
          command: `node -e "require('node:fs').writeFileSync('every-gate-suite-ran', '')"`,
        },
      ],
    }
    const loop = makeLoop({ taskGate: 'full' }, suiteProject)

    expect(loop.runCycleSuite(1)).toBe(true)

    expect(existsSync(join(repoRoot, 'light-suite-ran'))).toBe(false)
    expect(existsSync(join(repoRoot, 'every-gate-suite-ran'))).toBe(true)
    expect(existsSync(stopFile())).toBe(false)
    expect(logged).toContain('Started Suite       cycle 1')
  })

  it('runs the project suite under light gates and continues on a pass', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Marker', cwd: '',
        command: `node -e "require('node:fs').writeFileSync('suite-ran', '')"`,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(1)).toBe(true)
    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(true)
    expect(existsSync(stopFile())).toBe(false)
    expect(logged).toContain('Started Suite       cycle 1')
  })

  it('stops before running a Docker suite when its probe is not configured', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Docker suite', cwd: '',
        command: `node -e "require('node:fs').writeFileSync('suite-ran', '')"`,
        needsDocker: true,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(existsSync(stopFile())).toBe(false)
    expect(loop.runCycleSuite(1)).toBe(false)

    expect(logText()).toContain('ERROR cycle suite infrastructure probe is not configured')
    expect(existsSync(stopFile())).toBe(true)
    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(false)
  })

  it('stops before running suite steps when the Docker probe fails', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuiteDockerProbe: {
        command: 'node -e "process.exit(1)"',
        timeoutMs: 1_000,
        remediation: 'start the fixture service and restart the loop',
      },
      cycleSuite: () => [{
        label: 'Docker suite', cwd: '',
        command: `node -e "require('node:fs').writeFileSync('suite-ran', '')"`,
        needsDocker: true,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(1)).toBe(false)

    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(false)
    expect(existsSync(stopFile())).toBe(true)
    expect(logText()).toContain(
      'ERROR start the fixture service and restart the loop',
    )
  })

  it('probes once and runs Docker-dependent suite steps when the probe passes', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuiteDockerProbe: {
        command: `node -e "require('node:fs').appendFileSync('docker-probes', 'probe\\n')"`,
        timeoutMs: 1_000,
        remediation: 'start the fixture service and restart the loop',
      },
      cycleSuite: () => [
        {
          label: 'First Docker suite', cwd: '',
          command: `node -e "require('node:fs').writeFileSync('suite-ran', '')"`,
          needsDocker: true,
        },
        {
          label: 'Second Docker suite', cwd: '',
          command: `node -e "require('node:fs').writeFileSync('suite-ran-again', '')"`,
          needsDocker: true,
        },
      ],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(1)).toBe(true)

    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(true)
    expect(existsSync(join(repoRoot, 'suite-ran-again'))).toBe(true)
    expect(readFileSync(join(repoRoot, 'docker-probes'), 'utf8').trim()).toBe('probe')
    expect(existsSync(stopFile())).toBe(false)
  })

  it('stops the loop rather than promote a failing tip', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Failing', cwd: '',
        command: `node -e "console.log('Tests run: 4, Failures: 1'); process.exit(1)"`,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(2)).toBe(false)
    expect(existsSync(stopFile())).toBe(true)
    expect(logText()).toContain('ERROR cycle suite failed')
  })

  it('attributes a tool-not-found failure to the environment, not the branch', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Broken toolchain', cwd: '',
        command: `node -e "console.log('vitest is not recognized as an internal or external command'); process.exit(1)"`,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(5)).toBe(false)
    expect(logText()).toContain('ERROR cycle suite tool missing')
    expect(existsSync(stopFile())).toBe(true)
  })

  it('uses project classification after a passing infrastructure probe', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuiteDockerProbe: {
        command: 'node -e ""', timeoutMs: 1_000,
        remediation: 'start the fixture service and restart the loop',
      },
      classifyInfrastructureFailure: (output) => output.includes('fixture service unavailable')
        ? {
            diagnosis: 'the fixture service is unavailable',
            remediation: 'restart the fixture service and restart the loop',
          }
        : undefined,
      cycleSuite: () => [{
        label: 'Infrastructure suite', cwd: '', needsDocker: true,
        command: `node -e "console.log('fixture service unavailable'); process.exit(1)"`,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(5)).toBe(false)

    expect(logText()).toContain('ERROR restart the fixture service and restart the loop')
    expect(logText()).not.toContain('ERROR cycle suite failed')
    expect(existsSync(stopFile())).toBe(true)
  })

  it('classifies only the current run when a reused log contains an earlier tool failure', () => {
    const suiteLog = join(paths.logsDir, 'cycle-suite-6.log')
    writeFileSync(suiteLog, 'vitest is not recognized as an internal or external command\n')
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Failing test', cwd: '',
        command: `node -e "console.log('Tests run: 4, Failures: 1'); process.exit(1)"`,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(6)).toBe(false)

    expect(logText()).toContain('ERROR cycle suite failed')
    expect(logText()).not.toContain('tool missing')
    expect(readFileSync(suiteLog, 'utf8')).toContain('Tests run: 4, Failures: 1')
    expect(readFileSync(suiteLog, 'utf8')).not.toContain('vitest is not recognized')
  })

  it('runs the repair when its marker path is missing and skips it when present', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Repairable', cwd: '',
        command: `node -e "require('node:fs').writeFileSync('suite-ran', '')"`,
        repairWhenMissing: {
          path: 'launcher-shim',
          command: `node -e "require('node:fs').writeFileSync('repaired', '')"`,
          message: 'the launcher is missing',
        },
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(3)).toBe(true)
    expect(existsSync(join(repoRoot, 'repaired'))).toBe(true)

    rmSync(join(repoRoot, 'repaired'))
    writeFileSync(join(repoRoot, 'launcher-shim'), '')
    expect(loop.runCycleSuite(4)).toBe(true)
    expect(existsSync(join(repoRoot, 'repaired'))).toBe(false)
  })

  it('stops and reports the remediation when a missing-toolchain repair fails', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Repairable', cwd: '',
        command: `node -e "require('node:fs').writeFileSync('suite-ran', '')"`,
        repairWhenMissing: {
          path: 'launcher-shim',
          command: 'node -e "process.exit(1)"',
          message: 'restore the launcher and restart the loop',
        },
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(7)).toBe(false)

    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(false)
    expect(existsSync(stopFile())).toBe(true)
    expect(logText()).toContain('ERROR restore the launcher and restart the loop')
  })

  it('skips a step whose required path is absent', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Absent', cwd: 'nowhere', command: 'node -e "process.exit(1)"', requires: 'nowhere',
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(6)).toBe(true)
  })
})
