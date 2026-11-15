import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import {
  branchName, finalMessageFile, orchPaths, statusFile, worktreeDir, type OrchPaths,
} from '../src/paths.ts'
import { recordTaskProcess, terminableTaskProcessPid } from '../src/processRegistry.ts'
import {
  completionMarkerPresent, markerLinePresent, noChangeMarkerPresent, refreshAll, refreshTask,
} from '../src/refresh.ts'

let repoRoot: string
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-refresh-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

function writeRawStatus(taskId: string, content: string): string {
  const file = statusFile(paths, taskId)
  const partial = JSON.parse(content) as Record<string, unknown>
  const record = {
    task_id: taskId,
    started_at: '2026-08-08T03:00:00Z',
    updated_at: '2026-08-08T03:00:00Z',
    worktree: worktreeDir(paths, taskId),
    branch: branchName(taskId),
    ...partial,
  }
  writeFileSync(file, `${JSON.stringify(record)}\n`)
  // A running task's process lives in the registry, not in the record. A fixture that
  // names one has to put it where the reader looks.
  const pid = (JSON.parse(content) as { pid?: number | null }).pid
  if (typeof pid === 'number') recordTaskProcess(paths, taskId, pid)
  return file
}

function ageFile(file: string): void {
  const past = (Date.now() - 30 * 24 * 3600 * 1000) / 1000
  utimesSync(file, past, past)
}

describe('refreshAll', () => {
  // Terminal files carry sentinel fields not owned by refresh. A refresh must leave
  // their content exactly as found.
  it('leaves terminal files byte-for-byte untouched', async () => {
    const merged = writeRawStatus('merged-task',
      '{"status":"merged","merge_commit":"merge-commit","run_branch":"main",'
      + '"sentinel":"keep merged"}\n')
    const noChange = writeRawStatus('no-change-task',
      '{"status":"no-change","sentinel":"keep no change"}\n')
    const failed = writeRawStatus('failed-task', '{"status":"failed","sentinel":"keep failed"}\n')
    ageFile(merged)
    ageFile(noChange)
    ageFile(failed)
    const mergedBefore = { content: readFileSync(merged, 'utf8'), mtime: statSync(merged).mtimeMs }
    const noChangeBefore = {
      content: readFileSync(noChange, 'utf8'), mtime: statSync(noChange).mtimeMs,
    }
    const failedBefore = { content: readFileSync(failed, 'utf8'), mtime: statSync(failed).mtimeMs }

    await refreshAll(paths)

    expect(readFileSync(merged, 'utf8')).toBe(mergedBefore.content)
    expect(readFileSync(noChange, 'utf8')).toBe(noChangeBefore.content)
    expect(readFileSync(failed, 'utf8')).toBe(failedBefore.content)
    expect(statSync(merged).mtimeMs).toBe(mergedBefore.mtime)
    expect(statSync(noChange).mtimeMs).toBe(noChangeBefore.mtime)
    expect(statSync(failed).mtimeMs).toBe(failedBefore.mtime)
  })

  it('rewrites a stale running task as failed', async () => {
    const file = writeRawStatus('running-task', '{"task_id":"running-task","status":"running","pid":null}\n')
    ageFile(file)
    const lines = await refreshAll(paths)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { status: string }
    expect(parsed.status).toBe('failed')
    expect(lines.some((line) => line.startsWith('running-task') && line.includes('failed'))).toBe(true)
  })
})

describe('refreshTask', () => {
  it('completes a dead task whose final message carries the marker', async () => {
    writeRawStatus('done-task', '{"task_id":"done-task","status":"running","pid":null}\n')
    writeFileSync(finalMessageFile(paths, 'done-task'), 'All finished.\nTASK_COMPLETE\n')
    const after = await refreshTask(paths, 'done-task')
    expect(after?.status).toBe('completed')
  })

  it('leaves a task without a process record running while no daemon owns the queue', async () => {
    const file = writeRawStatus('stopped-task', '{"status":"running","pid":null}\n')
    const before = readFileSync(file, 'utf8')

    const after = await refreshTask(paths, 'stopped-task', { daemonOwnsQueue: false })

    expect(after?.status).toBe('running')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('fails a task whose process record outlived its runner while no daemon owns the queue',
    async () => {
      const processStartIdentity = vi.spyOn(operatingSystem, 'processStartIdentity')
        .mockReturnValue('started:crashed')
      writeRawStatus('crashed-task', '{"status":"running","pid":2147483647}\n')
      processStartIdentity.mockReturnValue(undefined)
      vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(false)
      vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(false)

      const after = await refreshTask(paths, 'crashed-task', { daemonOwnsQueue: false })

      expect(after).toMatchObject({ status: 'failed', pid: null })
    })

  it('completes a task without a process record while no daemon owns the queue', async () => {
    writeRawStatus('stopped-done', '{"status":"running","pid":null}\n')
    writeFileSync(finalMessageFile(paths, 'stopped-done'), 'TASK_COMPLETE\n')

    const after = await refreshTask(paths, 'stopped-done', { daemonOwnsQueue: false })

    expect(after?.status).toBe('completed')
  })

  it('keeps a live task running while the marker is absent', async () => {
    writeRawStatus('live-task', `{"task_id":"live-task","status":"running","pid":${process.pid}}\n`)
    const after = await refreshTask(paths, 'live-task')
    expect(after?.status).toBe('running')
  })

  it('uses the operating-system liveness verdict for a task process', async () => {
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('started:protected')
    writeRawStatus('protected-task', '{"task_id":"protected-task","status":"running","pid":2147483647}\n')

    const after = await refreshTask(paths, 'protected-task')

    expect(processIsAlive).toHaveBeenCalledWith(2147483647)
    expect(after?.status).toBe('running')
  })

  it('defers failure while identity is unavailable and keeps ownership after recovery', async () => {
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)
    const processStartIdentity = vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockReturnValue('started:protected')
    writeRawStatus(
      'probe-task',
      '{"task_id":"probe-task","status":"running","pid":2147483647}\n',
    )
    processStartIdentity.mockReturnValue(undefined)

    expect((await refreshTask(paths, 'probe-task'))?.status).toBe('running')

    processStartIdentity.mockReturnValue('started:protected')
    expect((await refreshTask(paths, 'probe-task'))?.status).toBe('running')
    expect(processIsAlive).toHaveBeenCalledWith(2147483647)
  })

  it('retains ownership when the runner exits but its process tree remains alive', async () => {
    const processStartIdentity = vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockReturnValue('started:orphaned')
    vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(false)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)
    writeRawStatus(
      'orphaned-task',
      '{"task_id":"orphaned-task","status":"running","pid":2147483647}\n',
    )
    processStartIdentity.mockReturnValue(undefined)

    expect((await refreshTask(paths, 'orphaned-task'))?.status).toBe('failed')
    expect(terminableTaskProcessPid(paths, 'orphaned-task')).toBeUndefined()
  })

  it('completes a live task once the marker appears', async () => {
    writeRawStatus('live-done', `{"task_id":"live-done","status":"running","pid":${process.pid}}\n`)
    writeFileSync(finalMessageFile(paths, 'live-done'), 'TASK_COMPLETE\n')
    const after = await refreshTask(paths, 'live-done')
    expect(after?.status).toBe('completed')
    expect(after?.pid).toBe(process.pid)
  })

  it('does not make an initially unverified live PID terminable while completing it', async () => {
    const pid = 2147483647
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    const processStartIdentity = vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockReturnValue(undefined)
    writeRawStatus('unverified-done',
      `{"task_id":"unverified-done","status":"running","pid":${pid}}\n`)
    processStartIdentity.mockReturnValue('started:possibly-reused')
    writeFileSync(finalMessageFile(paths, 'unverified-done'), 'TASK_COMPLETE\n')

    const after = await refreshTask(paths, 'unverified-done')

    expect(after).toMatchObject({ status: 'completed', pid })
    expect(terminableTaskProcessPid(paths, 'unverified-done')).toBeUndefined()
    expect(processIsAlive).toHaveBeenCalledWith(pid)
  })
})

describe('completionMarkerPresent', () => {
  it('requires the marker on its own line in the final message', () => {
    writeFileSync(finalMessageFile(paths, 'x'), 'the prompt said to print TASK_COMPLETE at the end\n')
    expect(completionMarkerPresent(paths, 'x')).toBe(false)
    writeFileSync(finalMessageFile(paths, 'x'), 'work done\nTASK_COMPLETE\n')
    expect(completionMarkerPresent(paths, 'x')).toBe(true)
  })

  it('never reads the transcript log', () => {
    writeFileSync(join(paths.logsDir, 'y.log'), 'TASK_COMPLETE\n')
    expect(completionMarkerPresent(paths, 'y')).toBe(false)
  })
})

describe('noChangeMarkerPresent', () => {
  it('requires the no-change verdict on its own line in the final message', () => {
    writeFileSync(finalMessageFile(paths, 'x'), 'No change warranted in prose.\nTASK_COMPLETE\n')
    expect(noChangeMarkerPresent(paths, 'x')).toBe(false)
    writeFileSync(finalMessageFile(paths, 'x'), 'NO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    expect(noChangeMarkerPresent(paths, 'x')).toBe(true)
  })
})

describe('markerLinePresent', () => {
  const markers = ['TASK_COMPLETE', 'NO_CHANGE_WARRANTED', 'NO_FINDINGS']

  for (const marker of markers) {
    it(`recognises ${marker} bare, padded, and in one layer of inline formatting`, () => {
      for (const line of [
        marker,
        `${marker}  \t`,
        `\`${marker}\``,
        `**${marker}**`,
        `__${marker}__`,
        `*${marker}*`,
        `_${marker}_`,
        `\`${marker}\`  `,
      ]) {
        expect(markerLinePresent(`work done\n${line}\n`, marker), line).toBe(true)
        expect(markerLinePresent(`work done\r\n${line}\r\n`, marker), line).toBe(true)
      }
      for (const line of [`   ${marker}  \t`, `  \`${marker}\`  `]) {
        expect(markerLinePresent(`work done\n${line}\n`, marker), line).toBe(false)
        expect(markerLinePresent(`work done\r\n${line}\r\n`, marker), line).toBe(false)
      }
    })

    it(`does not recognise ${marker} after leading white space, as git indents it`, () => {
      for (const line of [
        `  ${marker}`,
        `\t${marker}`,
        `    ${marker}`,
        ` ${marker}`,
        `    \`${marker}\``,
      ]) {
        expect(markerLinePresent(`work done\n${line}\n`, marker), line).toBe(false)
      }
      expect(markerLinePresent(
        `commit 0da4564\nAuthor: someone\n\n    fix: something\n\n    ${marker}\n`, marker,
      )).toBe(false)
      expect(markerLinePresent(
        `@@ -1,3 +1,4 @@\n Output this line:\n ${marker}\n+added\n`, marker,
      )).toBe(false)
    })

    it(`recognises ${marker} followed by trailing spaces, a tab, or a carriage return`, () => {
      for (const line of [`${marker}   `, `${marker}\t`, `${marker}\r`, `**${marker}**\t\r`]) {
        expect(markerLinePresent(`work done\n${line}\n`, marker), line).toBe(true)
        expect(markerLinePresent(`work done\n${line}`, marker), line).toBe(true)
      }
    })

    it(`recognises ${marker} as the only line of a closed fenced code block`, () => {
      for (const text of [
        `work done\n\`\`\`\n${marker}\n\`\`\`\n`,
        `work done\n~~~\n${marker}\n~~~\n`,
        `work done\n\`\`\`text\n${marker}\n\`\`\`\n`,
        `work done\n~~~ text\n${marker}\n~~~~\n`,
        `work done\n\`\`\`\n\n  \n${marker}\n\n\`\`\`\n`,
        `work done\r\n\`\`\`\r\n${marker}\r\n\`\`\`  \r\n`,
        `work done\n\`\`\`\n\`${marker}\`\n\`\`\`\n`,
      ]) {
        expect(markerLinePresent(text, marker), text).toBe(true)
      }
      expect(markerLinePresent(`work done\n\`\`\`\n  ${marker}\n\`\`\`\n`, marker)).toBe(false)
    })

    it(`does not recognise ${marker} beside other lines in a closed fenced code block`, () => {
      for (const text of [
        `The prompt says:\n\`\`\`\nfinish the work\n${marker}\n\`\`\`\n`,
        `~~~text\n${marker}\nmore\n~~~\n`,
        `\`\`\`\`\n\`\`\`\n${marker}\n\`\`\`\n\`\`\`\`\n`,
        `\`\`\`\nsteps\n~~~\n${marker}\n\`\`\`\n`,
      ]) {
        expect(markerLinePresent(text, marker), text).toBe(false)
      }
    })

    it(`recognises a bare final ${marker} after fences that never close`, () => {
      const misNested = [
        'work done', '```markdown', 'Run:', '```bash', 'npm test', '```', 'more', '```',
        marker, '',
      ].join('\n')
      expect(markerLinePresent(misNested, marker)).toBe(true)
      expect(markerLinePresent(`work done\n\`\`\`\nnpm test\n${marker}\n`, marker)).toBe(true)
      expect(markerLinePresent(`work done\n~~~~\nlog\n~~~\n${marker}\n`, marker)).toBe(true)
    })

    it(`does not treat a line that continues after three backticks as a fence`, () => {
      expect(markerLinePresent(`\`\`\`npm test\`\`\` passes\n${marker}\n`, marker)).toBe(true)
      expect(markerLinePresent(
        `\`\`\`npm test\`\`\` passes\nnotes\n\`\`\`\nlog\n${marker}\n\`\`\`\n`, marker,
      )).toBe(false)
    })

    it(`does not recognise ${marker} with anything else on its line`, () => {
      for (const line of [
        `print ${marker} at the end`,
        `${marker}.`,
        `\`${marker}\`.`,
        `- ${marker}`,
        `* ${marker}`,
        `1. ${marker}`,
        `> ${marker}`,
        `>${marker}`,
        `\`${marker}`,
        `${marker}\``,
        `**\`${marker}\`**`,
        `\`**${marker}**\``,
        `***${marker}***`,
        `\`\`${marker}\`\``,
        `\`\`\`${marker}\`\`\``,
        `**${marker}*`,
        `\` ${marker} \``,
      ]) {
        expect(markerLinePresent(`work done\n${line}\n`, marker), line).toBe(false)
      }
    })

    it(`recognises ${marker} alone in a fenced code block and bare after one`, () => {
      expect(markerLinePresent(`The prompt says:\n\`\`\`\n${marker}\n\`\`\`\n`, marker)).toBe(true)
      expect(markerLinePresent(`~~~text\n${marker}\n~~~\n`, marker)).toBe(true)
      expect(markerLinePresent(`\`\`\`\n${marker}\n\`\`\`\n${marker}\n`, marker)).toBe(true)
    })
  }

  it('recognises a formatted marker only from the final message, never the transcript', () => {
    writeFileSync(join(paths.logsDir, 'z.log'), '`TASK_COMPLETE`\n**NO_CHANGE_WARRANTED**\n')
    writeFileSync(finalMessageFile(paths, 'z'), 'work done\n')
    expect(completionMarkerPresent(paths, 'z')).toBe(false)
    expect(noChangeMarkerPresent(paths, 'z')).toBe(false)
    writeFileSync(finalMessageFile(paths, 'z'), 'work done\n`NO_CHANGE_WARRANTED`\n`TASK_COMPLETE`\n')
    expect(completionMarkerPresent(paths, 'z')).toBe(true)
    expect(noChangeMarkerPresent(paths, 'z')).toBe(true)
  })
})

describe('refreshTask deadline', () => {
  const pid = 2147483647
  const startedAt = Date.parse('2026-08-08T03:00:00Z')
  const hours = (count: number) => startedAt + count * 3_600_000

  function liveOverdueTask(taskId: string) {
    vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    const processTreeIsAlive = vi.spyOn(operatingSystem, 'processTreeIsAlive')
      .mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('started:stuck')
    writeRawStatus(taskId, `{"status":"running","pid":${pid}}\n`)
    return processTreeIsAlive
  }

  it('stops an overdue tree and fails the task with the reason in its log', async () => {
    const processTreeIsAlive = liveOverdueTask('stuck-task')
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockImplementation(() => {
      processTreeIsAlive.mockReturnValue(false)
      return true
    })
    const verdicts: unknown[] = []

    const after = await refreshTask(paths, 'stuck-task', {
      taskDeadlineHours: 4, now: () => hours(4), onDeadline: (verdict) => verdicts.push(verdict),
    })

    expect(terminate).toHaveBeenCalledWith(pid)
    expect(after).toMatchObject({ status: 'failed', pid: null })
    expect(verdicts).toEqual([{ taskId: 'stuck-task', pid, stopped: true }])
    expect(readFileSync(join(paths.logsDir, 'stuck-task.log'), 'utf8')).toContain(
      'Task deadline exceeded: running since 2026-08-08T03:00:00Z, past the 4-hour task '
      + `deadline; process tree ${pid} was stopped`,
    )
  })

  it('keeps an overdue task running while its tree survives termination', async () => {
    liveOverdueTask('resisting-task')
    vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    const verdicts: unknown[] = []

    const after = await refreshTask(paths, 'resisting-task', {
      taskDeadlineHours: 4, now: () => hours(5), onDeadline: (verdict) => verdicts.push(verdict),
    })

    expect(after).toMatchObject({ status: 'running', pid })
    expect(verdicts).toEqual([{
      taskId: 'resisting-task', pid, stopped: false,
      error: 'process tree termination could not be verified',
    }])
    expect(terminableTaskProcessPid(paths, 'resisting-task')).toBe(pid)
  })

  it('does not stop an overdue PID whose start identity no longer matches', async () => {
    liveOverdueTask('reused-task')
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('started:reused')
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    const verdicts: unknown[] = []

    const after = await refreshTask(paths, 'reused-task', {
      taskDeadlineHours: 4, now: () => hours(5), onDeadline: (verdict) => verdicts.push(verdict),
    })

    expect(terminate).not.toHaveBeenCalled()
    expect(after).toMatchObject({ status: 'running', pid })
    expect(verdicts).toEqual([{
      taskId: 'reused-task', pid, stopped: false,
      error: 'process identity was not captured at launch or is currently unavailable',
    }])
  })

  it('does not stop an overdue task whose recorded process changed after the read', async () => {
    const otherPid = pid - 1
    liveOverdueTask('handed-over-task')
    // The registry is rewritten between the status read and the deadline stop.
    vi.spyOn(operatingSystem, 'processIsAlive').mockImplementation(() => {
      recordTaskProcess(paths, 'handed-over-task', otherPid)
      return true
    })
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    const verdicts: unknown[] = []

    const after = await refreshTask(paths, 'handed-over-task', {
      taskDeadlineHours: 4, now: () => hours(5), onDeadline: (verdict) => verdicts.push(verdict),
    })

    expect(terminate).not.toHaveBeenCalled()
    expect(after).toMatchObject({ status: 'running', pid })
    expect(verdicts).toEqual([{
      taskId: 'handed-over-task', pid, stopped: false, error: 'task process ownership changed',
    }])
    expect(terminableTaskProcessPid(paths, 'handed-over-task')).toBe(otherPid)
  })

  it('does not stop a task before its deadline or when no deadline is set', async () => {
    liveOverdueTask('young-task')
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)

    const early = await refreshTask(paths, 'young-task', {
      taskDeadlineHours: 4, now: () => hours(4) - 1,
    })
    const unlimited = await refreshTask(paths, 'young-task', {
      taskDeadlineHours: 0, now: () => hours(1000),
    })

    expect(early?.status).toBe('running')
    expect(unlimited?.status).toBe('running')
    expect(terminate).not.toHaveBeenCalled()
  })

  it('completes an overdue task whose marker already arrived', async () => {
    liveOverdueTask('late-done')
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    writeFileSync(finalMessageFile(paths, 'late-done'), 'TASK_COMPLETE\n')

    const after = await refreshTask(paths, 'late-done', {
      taskDeadlineHours: 4, now: () => hours(10),
    })

    expect(after?.status).toBe('completed')
    expect(terminate).not.toHaveBeenCalled()
  })
})
