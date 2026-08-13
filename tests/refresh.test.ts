import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import { finalMessageFile, orchPaths, statusFile, type OrchPaths } from '../src/paths.ts'
import { recordTaskProcess } from '../src/processRegistry.ts'
import { completionMarkerPresent, refreshAll, refreshTask } from '../src/refresh.ts'

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
  writeFileSync(file, content)
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
  // Terminal files deliberately contain only enough JSON to classify them. A refresh
  // must not inspect other fields, and must leave their content exactly as found.
  it('leaves merged and failed files byte-for-byte untouched', async () => {
    const merged = writeRawStatus('merged-task', '{"status":"merged","sentinel":"keep merged"}\n')
    const failed = writeRawStatus('failed-task', '{"status":"failed","sentinel":"keep failed"}\n')
    ageFile(merged)
    ageFile(failed)
    const mergedBefore = { content: readFileSync(merged, 'utf8'), mtime: statSync(merged).mtimeMs }
    const failedBefore = { content: readFileSync(failed, 'utf8'), mtime: statSync(failed).mtimeMs }

    await refreshAll(paths)

    expect(readFileSync(merged, 'utf8')).toBe(mergedBefore.content)
    expect(readFileSync(failed, 'utf8')).toBe(failedBefore.content)
    expect(statSync(merged).mtimeMs).toBe(mergedBefore.mtime)
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

  it('keeps a live task running while the marker is absent', async () => {
    writeRawStatus('live-task', `{"task_id":"live-task","status":"running","pid":${process.pid}}\n`)
    const after = await refreshTask(paths, 'live-task')
    expect(after?.status).toBe('running')
  })

  it('uses the operating-system liveness verdict for a task process', async () => {
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    writeRawStatus('protected-task', '{"task_id":"protected-task","status":"running","pid":2147483647}\n')

    const after = await refreshTask(paths, 'protected-task')

    expect(processIsAlive).toHaveBeenCalledWith(2147483647)
    expect(after?.status).toBe('running')
  })

  it('completes a live task once the marker appears', async () => {
    writeRawStatus('live-done', `{"task_id":"live-done","status":"running","pid":${process.pid}}\n`)
    writeFileSync(finalMessageFile(paths, 'live-done'), 'TASK_COMPLETE\n')
    const after = await refreshTask(paths, 'live-done')
    expect(after?.status).toBe('completed')
    expect(after?.pid).toBe(process.pid)
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
