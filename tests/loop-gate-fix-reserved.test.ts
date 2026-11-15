import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateFixSpecFile, readGateFixState } from '../src/gateFix.ts'
import { LABEL_IN_PROGRESS, recordIssuesForTask } from '../src/issueQueue.ts'
import { mergeTask } from '../src/merge.ts'
import { branchName, statusFile, worktreeDir } from '../src/paths.ts'
import { currentProcessStartIdentity } from '../src/processOwner.ts'
import { forgetTaskProcess } from '../src/processRegistry.ts'
import { readStatus } from '../src/status.ts'
import { enqueueTask } from '../src/tasks.ts'
import {
  controlledProcess, expectReturnedToCompleted, failureCount, finishHandback, gateConfig,
  handBackClaimedTask, handbacks, makeTask, scriptedGate,
} from './gateFixHarness.ts'
import {
  backlogEntries, fakeForge, git, initializeGitRepo, logged, makeLoop, paths, registerLoopHooks,
  runnerStarts, setLogged, writeFinal, writeRawStatus,
} from './loopHarness.ts'

registerLoopHooks()

/** Stand in for a manual merge command holding the task's merge guard. */
function holdMergeGuard(taskId: string): string {
  const guardDir = join(paths.queueDir, 'merge-guards', taskId)
  mkdirSync(guardDir, { recursive: true })
  writeFileSync(join(guardDir, 'owner.json'), `${JSON.stringify({
    state: 'active',
    pid: process.pid,
    startIdentity: currentProcessStartIdentity(),
  })}\n`)
  return guardDir
}

describe('merge gate handback', () => {
  // Tests that control a runner process restore the operating system afterwards.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('neither loses nor repeats a handback across a daemon restart', async () => {
    const taskId = '20261112_090000_307_auto-gate-fix-restart'
    const busyId = '20261112_090000_308_auto-gate-fix-busy'
    initializeGitRepo()
    makeTask(taskId)
    // Another task holds the only parallel slot, so the reserved handback has to wait.
    writeRawStatus(busyId, 'running', process.pid)
    const loop = makeLoop(gateConfig, scriptedGate(['fail']))
    loop.initializeSessionStateForBranch()

    await loop.poll()
    await loop.poll()

    expect(handbacks()).toEqual([])
    expect(runnerStarts).toEqual([])
    expect(failureCount()).toBe('1\n')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(readGateFixState(paths, taskId)).toEqual({
      attempts: 1, verificationFailed: false, pending: true,
    })

    // The daemon stops; the busy task is gone by the time a new one starts.
    rmSync(statusFile(paths, busyId))
    forgetTaskProcess(paths, busyId)
    setLogged([])
    const restarted = makeLoop(gateConfig, scriptedGate(['fail']))

    await restarted.poll()

    // The reserved attempt starts without running the gate that already failed twice.
    expect(logged.some((line) => line.startsWith('Merging 307_auto'))).toBe(false)
    expect(handbacks()).toEqual([
      'Handback 307_auto    attempt 1/1  verification failed twice; runner restarted',
    ])
    expect(runnerStarts).toEqual([gateFixSpecFile(paths, taskId)])
    expect(failureCount()).toBe('1\n')
    expect(readGateFixState(paths, taskId)).toEqual({
      attempts: 1, verificationFailed: false, pending: false,
    })

    finishHandback(taskId)
    const again = makeLoop(gateConfig, scriptedGate(['fail']))
    await again.poll()
    await again.poll()

    expect(handbacks()).toHaveLength(1)
    expect(runnerStarts).toHaveLength(1)
    expect(failureCount()).toBe('3\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })

  it('asks a handed-back grouped task for each requirement line it owes', async () => {
    const taskId = '20261112_090000_311_auto-gate-fix-grouped'
    initializeGitRepo()
    makeTask(taskId)
    const loop = makeLoop(gateConfig, scriptedGate(['fail']))
    loop.initializeSessionStateForBranch()
    // The merge re-reads each claim, so the issues are open and held by this task.
    const issueNumbers = [
      await fakeForge.createIssue({ title: 'first', body: '', labels: [LABEL_IN_PROGRESS] }),
      await fakeForge.createIssue({ title: 'second', body: '', labels: [LABEL_IN_PROGRESS] }),
    ]
    recordIssuesForTask(paths, taskId, issueNumbers)
    writeFinal(taskId, `${issueNumbers.map((number) => `REQUIREMENT_COMPLETE: #${number}\n`).join('')}`
      + 'TASK_COMPLETE\n')

    await loop.poll()
    await loop.poll()

    expect(handbacks()).toHaveLength(1)
    const specification = readFileSync(runnerStarts[0]!, 'utf8').split('\n')
    for (const issueNumber of issueNumbers) {
      expect(specification).toContain(`REQUIREMENT_COMPLETE: #${issueNumber}`)
    }
  })

  it('defers a handback while a manual merge holds the task merge guard', async () => {
    const taskId = '20261112_090000_311_auto-gate-fix-guarded'
    const busyId = '20261112_090000_312_auto-gate-fix-guarded-busy'
    initializeGitRepo()
    makeTask(taskId)
    const tip = git(['rev-parse', branchName(taskId)]).trim()
    // Another task holds the only parallel slot, so the handback is reserved and waits.
    writeRawStatus(busyId, 'running', process.pid)
    const loop = makeLoop(gateConfig, scriptedGate(['fail']))
    loop.initializeSessionStateForBranch()
    await loop.poll()
    await loop.poll()
    expect(readGateFixState(paths, taskId)).toEqual({
      attempts: 1, verificationFailed: false, pending: true,
    })

    // The slot frees while a manual merge of the task holds its merge guard.
    rmSync(statusFile(paths, busyId))
    forgetTaskProcess(paths, busyId)
    const guardDir = holdMergeGuard(taskId)
    await loop.poll()

    expect(runnerStarts).toEqual([])
    expect(handbacks()).toEqual([])
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(readGateFixState(paths, taskId)?.pending).toBe(true)
    expect(git(['rev-parse', branchName(taskId)]).trim()).toBe(tip)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    // The manual merge goes on to merge exactly the commits the handback left alone.
    rmSync(guardDir, { recursive: true, force: true })
    const result = await mergeTask(paths, taskId, {
      taskGate: 'full',
      project: scriptedGate(['pass']),
      outputFile: join(paths.logsDir, `${taskId}.manual.log`),
    })
    expect(result.outcome).toBe('merged')
    expect(git(['rev-parse', 'HEAD^2']).trim()).toBe(tip)
    expect(readStatus(paths, taskId)?.status).toBe('merged')

    await loop.poll()
    expect(runnerStarts).toEqual([])
    expect(handbacks()).toEqual([])
  })

  it('starts a reserved handback in the first free slot ahead of the backlog', async () => {
    const taskId = '20261112_090000_313_auto-gate-fix-slot'
    const busyId = '20261112_090000_314_auto-gate-fix-slot-busy'
    const queuedId = '20261112_090000_315_auto-gate-fix-slot-queued'
    initializeGitRepo()
    makeTask(taskId)
    const busy = controlledProcess()
    writeRawStatus(busyId, 'running', busy.pid)
    writeFileSync(join(paths.tasksDir, `${queuedId}.md`), '# spec\n')
    expect(enqueueTask(paths, queuedId).outcome).toBe('enqueued')
    const loop = makeLoop(gateConfig, scriptedGate(['fail']))
    loop.initializeSessionStateForBranch()
    await loop.poll()
    await loop.poll()
    expect(readGateFixState(paths, taskId)?.pending).toBe(true)
    expect(runnerStarts).toEqual([])

    // The busy runner ends; the sweep reaches it only after the waiting handback.
    busy.end()
    await loop.poll()

    expect(readStatus(paths, busyId)?.status).toBe('failed')
    expect(runnerStarts).toEqual([])
    expect(backlogEntries()).toHaveLength(1)

    await loop.poll()

    expect(runnerStarts).toEqual([gateFixSpecFile(paths, taskId)])
    expect(handbacks()).toEqual([
      'Handback 313_auto    attempt 1/1  verification failed twice; runner restarted',
    ])
    expect(backlogEntries()).toHaveLength(1)
    expect(readStatus(paths, queuedId)).toBeUndefined()
  })

  it('never hands back a scan task that fails verification', async () => {
    const taskId = '20261112_090000_316_scan'
    initializeGitRepo()
    makeTask(taskId)
    const loop = makeLoop(gateConfig, scriptedGate(['fail']))
    loop.initializeSessionStateForBranch()

    for (let poll = 0; poll < 3; poll += 1) await loop.poll()

    expect(logged.filter((line) => line.startsWith('Failed 316_scan'))).toHaveLength(3)
    expect(handbacks()).toEqual([])
    expect(runnerStarts).toEqual([])
    expect(readGateFixState(paths, taskId)).toBeUndefined()
    expect(existsSync(gateFixSpecFile(paths, taskId))).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('stops the poll before merging a task whose gate fix record is malformed', async () => {
    const taskId = '20261112_090000_330_auto-gate-fix-malformed'
    initializeGitRepo()
    makeTask(taskId)
    const head = git(['rev-parse', 'HEAD']).trim()
    const tip = git(['rev-parse', branchName(taskId)]).trim()
    const record = join(paths.queueDir, 'gate-fix', `${taskId}.json`)
    mkdirSync(join(paths.queueDir, 'gate-fix'), { recursive: true })
    writeFileSync(record, '{"attempts": ')
    const loop = makeLoop(gateConfig, scriptedGate(['pass']))
    loop.initializeSessionStateForBranch()

    // Merging would discard whether these commits are owed a handback, so the error
    // leaves the poll and the daemon stops for a person to repair the record.
    await expect(loop.poll()).rejects.toThrow(
      new Error(`Malformed gate fix record ${record}; repair or remove it`),
    )

    expect(logged).toEqual(['Completed 330_auto'])
    expect(runnerStarts).toEqual([])
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(head)
    expect(git(['rev-parse', branchName(taskId)]).trim()).toBe(tip)
    expect(existsSync(worktreeDir(paths, taskId))).toBe(true)
    expect(readFileSync(record, 'utf8')).toBe('{"attempts": ')
  })

  it('returns a task whose handed-back runner fails to completed', async () => {
    const taskId = '20261112_090000_317_auto-gate-fix-runner-failed'
    const fixRun = controlledProcess()
    const { loop, issueNumber, tip } = await handBackClaimedTask(taskId, fixRun.runner)
    expect(readStatus(paths, taskId)?.status).toBe('running')
    expect(failureCount()).toBe('1\n')

    fixRun.end()
    await loop.poll()

    await expectReturnedToCompleted(taskId, tip, issueNumber)
    expect(handbacks()).toContain(
      'Handback 317_auto    attempt 1/1  fix run ended without completing; task returned to completed')
    // The returned task is merged again at once, and that failure is counted as before.
    expect(failureCount()).toBe('2\n')
    expect(runnerStarts).toHaveLength(1)
    await loop.poll()
    expect(failureCount()).toBe('3\n')
    expect(runnerStarts).toHaveLength(1)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    await expectReturnedToCompleted(taskId, tip, issueNumber)
  })
})
