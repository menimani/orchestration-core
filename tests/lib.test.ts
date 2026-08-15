import type { ChildProcess } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import { descSlug, newTaskId, shortTaskId, taskIdForDesc } from '../src/ids.ts'
import {
  branchName, finalMessageFile, isInspectionTaskId, isReviewTaskId,
  isScanTaskId,
  orchPaths, packageScriptCommand, statusFile, type OrchPaths,
} from '../src/paths.ts'
import { taskProcessPid } from '../src/processRegistry.ts'
import { readStatus, transitionStatus, writeStatus } from '../src/status.ts'
import { lockContentionProbeScript, TestProcessRegistry } from './testProcess.ts'

let repoRoot: string
let paths: OrchPaths
const testProcesses = new TestProcessRegistry()

function childOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`child exited ${code}: ${stderr}`))
    })
  })
}

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!files.every((file) => existsSync(file))) {
    if (Date.now() >= deadline) throw new Error('children did not reach ID allocation')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-lib-'))
  paths = orchPaths(repoRoot)
})

afterEach(async () => {
  await testProcesses.cleanup()
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('status files', () => {
  it('stores task status without the transient runner pid', async () => {
    await writeStatus(paths, 'task-alpha', 'running', process.pid)
    const stored = JSON.parse(readFileSync(statusFile(paths, 'task-alpha'), 'utf8')) as Record<string, unknown>
    const status = readStatus(paths, 'task-alpha')

    expect(status?.task_id).toBe('task-alpha')
    expect(status?.status).toBe('running')
    expect(stored).not.toHaveProperty('pid')
    expect(status?.pid).toBe(process.pid)
  })

  it('derives an unset pid as null without serializing it', async () => {
    await writeStatus(paths, 'task-nopid', 'completed')
    const stored = JSON.parse(readFileSync(statusFile(paths, 'task-nopid'), 'utf8')) as Record<string, unknown>

    expect(stored).not.toHaveProperty('pid')
    expect(readStatus(paths, 'task-nopid')?.pid).toBeNull()
  })

  it('preserves started_at across rewrites', async () => {
    await writeStatus(paths, 'task-repeat', 'running', 1)
    const first = readStatus(paths, 'task-repeat')?.started_at
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await writeStatus(paths, 'task-repeat', 'completed')
    expect(readStatus(paths, 'task-repeat')?.started_at).toBe(first)
  })

  it('makes a waiting writer block until the lock is released', async () => {
    await writeStatus(paths, 'task-locked', 'running', 1)
    const lockDir = join(paths.statusDir, '.task-locked.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`)

    let finished = false
    const writer = writeStatus(paths, 'task-locked', 'merged').then(() => { finished = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(finished).toBe(false)
    expect(readStatus(paths, 'task-locked')?.status).toBe('running')

    rmSync(join(lockDir, 'pid'))
    rmSync(lockDir, { recursive: true })
    await writer
    expect(readStatus(paths, 'task-locked')?.status).toBe('merged')
  })

  it('reclaims a lock whose recorded owner is dead', async () => {
    const lockDir = join(paths.statusDir, '.task-stale.lock')
    mkdirSync(lockDir)
    // PID 1 on Windows and near-max PIDs generally are not spawnable by us; use a PID
    // from a process we started and already reaped so liveness is provably false.
    const { spawnSync } = await import('node:child_process')
    const dead = spawnSync('node', ['-e', 'process.exit(0)']).pid ?? 99999
    writeFileSync(join(lockDir, 'pid'), `${dead}\n`)
    await writeStatus(paths, 'task-stale', 'completed')
    expect(readStatus(paths, 'task-stale')?.status).toBe('completed')
  })

  it('uses the operating-system liveness verdict before reclaiming a lock', async () => {
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(false)
    const lockDir = join(paths.statusDir, '.adapter-lock.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), '2147483647\n')

    await writeStatus(paths, 'adapter-lock', 'completed')

    expect(processIsAlive).toHaveBeenCalledWith(2147483647)
    expect(readStatus(paths, 'adapter-lock')?.status).toBe('completed')
  })

  it('reclaims a status lock when its live PID belongs to a different process start', async () => {
    const processStartIdentity = vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockReturnValue('current-start')
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    const lockDir = join(paths.statusDir, '.reused-pid-lock.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`)
    writeFileSync(join(lockDir, 'start-identity'), `${JSON.stringify('previous-start')}\n`)

    await writeStatus(paths, 'reused-pid-lock', 'completed')

    expect(processStartIdentity).toHaveBeenCalledWith(process.pid)
    expect(processIsAlive).not.toHaveBeenCalledWith(process.pid)
    expect(readStatus(paths, 'reused-pid-lock')?.status).toBe('completed')
  })

  it('reclaims an aged lock that never published a pid', async () => {
    const lockDir = join(paths.statusDir, '.task-pidless.lock')
    mkdirSync(lockDir)
    const past = (Date.now() - 60_000) / 1000
    utimesSync(lockDir, past, past)
    await writeStatus(paths, 'task-pidless', 'completed')
    expect(readStatus(paths, 'task-pidless')?.status).toBe('completed')
  })

  it('refuses a transition whose expected state is stale', async () => {
    await writeStatus(paths, 'task-cas', 'merged')
    expect(await transitionStatus(paths, 'task-cas', 'running', 'completed')).toBe(false)
    expect(readStatus(paths, 'task-cas')?.status).toBe('merged')
  })

  it('reads an absent status file as undefined', () => {
    expect(readStatus(paths, 'task-absent')).toBeUndefined()
  })

  it('does not treat a malformed existing status file as absent', () => {
    writeFileSync(statusFile(paths, 'task-malformed'), '{"status":"running"')
    expect(() => readStatus(paths, 'task-malformed')).toThrow(SyntaxError)
  })

  it('publishes status through a temporary file without leaving it behind', async () => {
    await writeStatus(paths, 'task-atomic', 'running', 12345)
    expect(existsSync(join(paths.statusDir, `.task-atomic.${process.pid}.tmp`))).toBe(false)
    expect(readStatus(paths, 'task-atomic')?.status).toBe('running')
  })

  it('keeps process ownership when terminal status publication is interrupted', async () => {
    const taskId = 'task-interrupted-terminal'
    await writeStatus(paths, taskId, 'running', process.pid)
    mkdirSync(join(paths.statusDir, `.${taskId}.${process.pid}.tmp`))

    await expect(writeStatus(paths, taskId, 'completed')).rejects.toThrow()

    expect(readStatus(paths, taskId)?.status).toBe('running')
    expect(taskProcessPid(paths, taskId)).toBe(process.pid)
  })

  it('derives the final message path from the log path', () => {
    expect(finalMessageFile(paths, 'task-alpha'))
      .toBe(join(paths.logsDir, 'task-alpha.final'))
  })
})

describe('package script commands', () => {
  it('runs scripts directly when the package is the repository root', () => {
    expect(packageScriptCommand(repoRoot, 'loop-status', repoRoot))
      .toBe('npm run loop-status')
  })

  it('selects the package directory when it is installed as a subtree', () => {
    expect(packageScriptCommand(repoRoot, 'stop', join(repoRoot, 'orchestration', 'ts')))
      .toBe('npm run -C orchestration/ts stop')
  })

  it('quotes a subtree package directory containing spaces', () => {
    expect(packageScriptCommand(repoRoot, 'stop', join(repoRoot, 'orchestration', 'core package')))
      .toBe('npm run -C "orchestration/core package" stop')
  })
})

describe('task ids', () => {
  it.each([
    ['20260810_024957_030_scan', '030_scan'],
    ['20260810_024957_031_auto-redesign-looplog', '031_auto'],
    ['20260810_024957_005_user-add-export', '005_user'],
    ['20260810_024957_012_ci-fix-c4', '012_ci-fix'],
    ['20260810_024957_227_review-c4', '227_review'],
  ])('derives the run-local id from %s', (full, short) => {
    expect(shortTaskId(full)).toBe(short)
  })

  it('mints ids as timestamp, per-day sequence and name', () => {
    const now = new Date(2026, 7, 8, 9, 30, 5)
    expect(newTaskId(paths, 'auto-fix-something', now))
      .toBe('20260808_093005_001_auto-fix-something')
    expect(newTaskId(paths, 'user-second', now))
      .toBe('20260808_093005_002_user-second')
  })

  it('resets the sequence on a new day', () => {
    newTaskId(paths, 'a', new Date(2026, 7, 8, 9, 0, 0))
    const next = newTaskId(paths, 'b', new Date(2026, 7, 9, 9, 0, 0))
    expect(next).toBe('20260809_090000_001_b')
  })

  it('serializes sequence allocation across processes', async () => {
    const lockDir = join(paths.queueDir, 'task-seq.txt.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)
    const idsModule = pathToFileURL(join(process.cwd(), 'src', 'ids.ts')).href
    const pathsModule = pathToFileURL(join(process.cwd(), 'src', 'paths.ts')).href
    const readyFiles = Array.from({ length: 4 }, (_, index) => join(repoRoot, `sequence-ready-${index}`))
    const children = readyFiles.map((readyFile, index) => testProcesses.spawn(process.execPath, [
      '--input-type=module', '--eval',
      [
        lockContentionProbeScript(4, 3),
        `const [{ newTaskId }, { orchPaths }] = await Promise.all([import(${JSON.stringify(idsModule)}), import(${JSON.stringify(pathsModule)})])`,
        'console.log(newTaskId(orchPaths(process.argv[1]), process.argv[2], new Date(2026, 7, 8, 9, 30, 5)))',
      ].join('\n'),
      repoRoot, `child-${index}`, readyFile, lockDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))
    const outputs = Promise.allSettled(children.map(childOutput))

    await waitForFiles(readyFiles)
    expect(children.every((child) => child.exitCode === null)).toBe(true)
    rmSync(lockDir, { recursive: true })

    const results = await outputs
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    const ids = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    expect(new Set(ids).size).toBe(4)
    expect(ids.map((id) => id.split('_')[2]).sort()).toEqual(['001', '002', '003', '004'])
  })

  it('slugs descriptions to lowercase alphanumerics capped at 30', () => {
    expect(descSlug('Fix the Header LAYOUT (mobile)')).toBe('fix-the-header-layout-mobile')
    expect(descSlug('x'.repeat(50)).length).toBe(30)
  })

  it('resolves the same description to the existing task', () => {
    const first = taskIdForDesc(paths, 'auto', 'fix the flaky calendar test')
    writeFileSync(join(paths.tasksDir, `${first}.md`), '# spec\n')
    const second = taskIdForDesc(paths, 'auto', 'fix the flaky calendar test')
    expect(second).toBe(first)
  })

  it('serializes description-index creation across processes', async () => {
    const lockDir = join(paths.queueDir, 'task-seq.txt.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)
    const idsModule = pathToFileURL(join(process.cwd(), 'src', 'ids.ts')).href
    const pathsModule = pathToFileURL(join(process.cwd(), 'src', 'paths.ts')).href
    const readyFiles = Array.from({ length: 4 }, (_, index) => join(repoRoot, `desc-ready-${index}`))
    const children = readyFiles.map((readyFile) => testProcesses.spawn(process.execPath, [
      '--input-type=module', '--eval',
      [
        lockContentionProbeScript(4, 3),
        `const [{ writeFileSync }, { join }, { taskIdForDesc }, { orchPaths }] = await Promise.all([import('node:fs'), import('node:path'), import(${JSON.stringify(idsModule)}), import(${JSON.stringify(pathsModule)})])`,
        "const paths = orchPaths(process.argv[1]); const id = taskIdForDesc(paths, 'auto', process.argv[2]); writeFileSync(join(paths.tasksDir, id + '.md'), '# spec\\n'); console.log(id)",
      ].join('\n'),
      repoRoot, 'the same concurrent finding', readyFile, lockDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))
    const outputs = Promise.allSettled(children.map(childOutput))

    await waitForFiles(readyFiles)
    expect(children.every((child) => child.exitCode === null)).toBe(true)
    rmSync(lockDir, { recursive: true })

    const results = await outputs
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    const ids = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    expect(new Set(ids).size).toBe(1)
  })

  it('mints a fresh id when the indexed spec is gone', () => {
    const first = taskIdForDesc(paths, 'auto', 'a finding whose spec was pruned')
    const second = taskIdForDesc(paths, 'auto', 'a finding whose spec was pruned')
    expect(second).not.toBe(first)
  })
})

describe('task id classes', () => {
  it('matches both scan id shapes', () => {
    expect(isScanTaskId('scan-20250101')).toBe(true)
    expect(isScanTaskId('20260808_093005_001_scan')).toBe(true)
    expect(isScanTaskId('20260808_093005_001_auto-fix')).toBe(false)
  })

  it('matches review ids', () => {
    expect(isReviewTaskId('20260808_093005_001_review-c2')).toBe(true)
    expect(isReviewTaskId('20260808_093005_001_auto-review-page')).toBe(false)
  })

  it('does not classify review-fix ids as inspections', () => {
    const id = '20260808_093005_001_fix-preserve-zero'
    expect(isReviewTaskId(id)).toBe(false)
    expect(isScanTaskId(id)).toBe(false)
    expect(isInspectionTaskId(paths, id)).toBe(false)
  })

  it('treats a delegated task with the inspect marker as inspection', () => {
    const id = '20260808_093005_001_user-report-only'
    expect(isInspectionTaskId(paths, id)).toBe(false)
    mkdirSync(join(paths.queueDir, 'inspect'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'inspect', id), '')
    expect(isInspectionTaskId(paths, id)).toBe(true)
  })
})

describe('branch names', () => {
  it('prefixes task branches', () => {
    expect(branchName('20260808_093005_001_auto-fix')).toBe('task/20260808_093005_001_auto-fix')
  })

  it('places status files in the status directory', () => {
    expect(statusFile(paths, 'x')).toBe(join(paths.statusDir, 'x.json'))
  })
})
