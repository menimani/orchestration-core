import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { describeFixtureChild, TestProcessRegistry } from './testProcess.ts'

const ROUNDS = 6
const CHILDREN = 4
const ALLOCATIONS = 20
// Bounds each round's Node startups and its contention; it guards against a hang, not
// against slowness on a host running other suites.
const ROUND_TIMEOUT_MS = 60_000

let repoRoot: string
let paths: OrchPaths
const testProcesses = new TestProcessRegistry()

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-backlog-stress-'))
  paths = orchPaths(repoRoot)
})

afterEach(async () => {
  await testProcesses.cleanup()
  rmSync(repoRoot, { recursive: true, force: true })
})

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

async function waitForFiles(files: string[], children: ChildProcess[]): Promise<void> {
  const deadline = Date.now() + ROUND_TIMEOUT_MS
  while (!files.every((file) => existsSync(file))) {
    if (Date.now() >= deadline) {
      const missing = files.flatMap((file, index) => existsSync(file)
        ? []
        : [`child ${index} (${describeFixtureChild(children[index]!)})`])
      throw new Error(`children did not load their modules: ${missing.join('; ')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Leave a lock directory behind as a process that died long ago would. */
function abandon(dir: string): void {
  mkdirSync(dir)
  writeFileSync(join(dir, 'owner'), `999999999 ${Date.now() - 31_000}\n`)
}

describe('backlog lock under process contention', () => {
  it('never crashes a contender and never hands out a sequence number twice', async () => {
    const lockDir = join(paths.queueDir, 'task-seq.txt.lock')
    const idsModule = pathToFileURL(join(process.cwd(), 'src', 'ids.ts')).href
    const pathsModule = pathToFileURL(join(process.cwd(), 'src', 'paths.ts')).href
    const allocated: string[] = []

    for (let round = 0; round < ROUNDS; round += 1) {
      // Every round opens with an abandoned recovery mutex, so the contenders race to
      // reclaim it; alternate rounds also abandon the main lock it guards.
      abandon(`${lockDir}.recovery`)
      if (round % 2 === 1) abandon(lockDir)
      const loadedFiles = Array.from({ length: CHILDREN }, (_, index) => join(repoRoot, `loaded-${round}-${index}`))
      const goFile = join(repoRoot, `go-${round}`)
      const children = loadedFiles.map((loadedFile, index) => testProcesses.spawn(process.execPath, [
        '--input-type=module', '--eval',
        [
          `const [{ existsSync, writeFileSync }, { newTaskId }, { orchPaths }] = await Promise.all([import('node:fs'), import(${JSON.stringify(idsModule)}), import(${JSON.stringify(pathsModule)})])`,
          "writeFileSync(process.argv[2], '')",
          `const goDeadline = Date.now() + ${ROUND_TIMEOUT_MS}`,
          "while (!existsSync(process.argv[3])) { if (Date.now() >= goDeadline) throw new Error('no go signal'); await new Promise((resolve) => setTimeout(resolve, 5)) }",
          'const paths = orchPaths(process.argv[1])',
          'const ids = []',
          `for (let index = 0; index < ${ALLOCATIONS}; index += 1) ids.push(newTaskId(paths, process.argv[4]))`,
          "console.log(JSON.stringify(ids))",
        ].join('\n'),
        repoRoot, loadedFile, goFile, `stress-${round}-${index}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))
      const outputs = Promise.allSettled(children.map(childOutput))

      await waitForFiles(loadedFiles, children)
      writeFileSync(goFile, '')
      const results = await outputs

      expect(results.filter((result) => result.status === 'rejected')).toEqual([])
      allocated.push(...results.flatMap((result) => result.status === 'fulfilled'
        ? JSON.parse(result.value) as string[]
        : []))
    }

    // The sequence restarts each day, so a number is unique together with its day.
    const sequenceNumbers = allocated.map((id) => `${id.slice(0, 8)} ${id.split('_')[2]}`)
    expect(sequenceNumbers).toHaveLength(ROUNDS * CHILDREN * ALLOCATIONS)
    expect(new Set(sequenceNumbers).size).toBe(sequenceNumbers.length)
    expect(readdirSync(paths.queueDir).filter((entry) => entry.startsWith('task-seq.txt.lock')))
      .toEqual([])
  }, ROUNDS * ROUND_TIMEOUT_MS)
})
