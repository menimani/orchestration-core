import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withBacklogLock } from '../src/backlog.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { specFile } from '../src/tasks.ts'

let repoRoot: string
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-backlog-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

function completion(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`child exited ${code}: ${stderr}`))
    })
  })
}

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!files.every((file) => existsSync(file))) {
    if (Date.now() >= deadline) throw new Error('children did not reach the backlog mutation')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('backlog process lock', () => {
  it.each([
    ['without owner metadata', undefined],
    ['with malformed owner metadata', `${process.pid}\n`],
  ])('reclaims an aged lock %s', (_description, owner) => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    if (owner !== undefined) writeFileSync(join(lockDir, 'owner'), owner)
    const old = new Date(Date.now() - 31_000)
    utimesSync(lockDir, old, old)

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(existsSync(lockDir)).toBe(false)
  })

  it('bounds acquisition when a live owner keeps the lock', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')

    expect(() => withBacklogLock(backlog, () => undefined))
      .toThrow(`Timed out waiting for the backlog lock: ${backlog}`)
  })

  it('recovers an aged recovery mutex abandoned beside a stale lock', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    const recoveryDir = `${lockDir}.recovery`
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `999999999 ${Date.now() - 31_000}\n`)
    mkdirSync(recoveryDir)
    const old = new Date(Date.now() - 31_000)
    utimesSync(recoveryDir, old, old)
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(existsSync(lockDir)).toBe(false)
    expect(existsSync(recoveryDir)).toBe(false)
  })

  it('serializes simultaneous recovery of one stale lock', async () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    const counter = join(repoRoot, 'mutation-count')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `999999999 ${Date.now() - 31_000}\n`)
    writeFileSync(counter, '0\n')

    const backlogModule = pathToFileURL(join(process.cwd(), 'src', 'backlog.ts')).href
    const script = [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const originalRmSync = fs.rmSync',
      'fs.rmSync = function (file, ...args) {',
      '  if (file === process.argv[2]) {',
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)',
      '  }',
      '  return originalRmSync.call(this, file, ...args)',
      '}',
      'syncBuiltinESMExports()',
      `const { withBacklogLock } = await import(${JSON.stringify(backlogModule)})`,
      'withBacklogLock(process.argv[1], () => {',
      "  const value = Number(fs.readFileSync(process.argv[3], 'utf8'))",
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)',
      "  fs.writeFileSync(process.argv[3], `${value + 1}\\n`)",
      '})',
    ].join('\n')
    const children = Array.from({ length: 2 }, () => spawn(process.execPath, [
      '--input-type=module', '--eval', script, backlog, lockDir, counter,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }))

    await Promise.all(children.map(completion))

    expect(readFileSync(counter, 'utf8')).toBe('2\n')
    expect(existsSync(`${lockDir}.recovery`)).toBe(false)
  })

  it('serializes a dequeue rewrite with a concurrent enqueue', async () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    writeFileSync(backlog, 'first-task:0\n')
    writeFileSync(specFile(paths, 'second-task'), '# second task\n')

    // Hold the same lock as a process already between its backlog read and write.
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)

    const backlogModule = pathToFileURL(join(process.cwd(), 'src', 'backlog.ts')).href
    const tasksModule = pathToFileURL(join(process.cwd(), 'src', 'tasks.ts')).href
    const pathsModule = pathToFileURL(join(process.cwd(), 'src', 'paths.ts')).href
    const dequeueReady = join(repoRoot, 'dequeue-ready')
    const enqueueReady = join(repoRoot, 'enqueue-ready')
    const dequeue = spawn(process.execPath, [
      '--input-type=module', '--eval',
      `const [{ writeFileSync }, { dequeueBacklog }] = await Promise.all([import('node:fs'), import(${JSON.stringify(backlogModule)})]); writeFileSync(process.argv[2], ''); dequeueBacklog(process.argv[1])`,
      backlog, dequeueReady,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const enqueue = spawn(process.execPath, [
      '--input-type=module', '--eval',
      `const [{ writeFileSync }, { enqueueTask }, { orchPaths }] = await Promise.all([import('node:fs'), import(${JSON.stringify(tasksModule)}), import(${JSON.stringify(pathsModule)})]); writeFileSync(process.argv[2], ''); enqueueTask(orchPaths(process.argv[1]), 'second-task')`,
      repoRoot, enqueueReady,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const dequeued = completion(dequeue)
    const enqueued = completion(enqueue)

    await waitForFiles([dequeueReady, enqueueReady])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(dequeue.exitCode).toBeNull()
    expect(enqueue.exitCode).toBeNull()
    expect(readFileSync(backlog, 'utf8')).toBe('first-task:0\n')

    rmSync(lockDir, { recursive: true })
    await Promise.all([dequeued, enqueued])

    expect(readFileSync(backlog, 'utf8')).toBe('second-task:0\n')
  })
})
