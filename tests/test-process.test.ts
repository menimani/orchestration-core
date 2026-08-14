import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import { PROCESS_TEST_TIMEOUT_MS } from './testProcess.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEST_PROCESS_MODULE = join(HERE, 'testProcess.ts')
const fixturePids: number[] = []
let fixtureRoot = ''

function waitUntil(predicate: () => boolean, message: string): void {
  const deadline = Date.now() + PROCESS_TEST_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

afterEach(() => {
  for (const pid of fixturePids.splice(0)) {
    if (operatingSystem.processTreeIsAlive(pid)) operatingSystem.terminateProcessTree(pid)
  }
  if (fixtureRoot !== '') rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

it('stops an eval fixture when its Vitest-like parent exits without cleanup', () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orch-test-process-'))
  const wrapperPidFile = join(fixtureRoot, 'wrapper.pid')
  const fixturePidFile = join(fixtureRoot, 'fixture.pid')
  const supervisor = join(fixtureRoot, 'supervisor.mjs')
  writeFileSync(supervisor, [
    `import { TestProcessRegistry } from ${JSON.stringify(pathToFileURL(TEST_PROCESS_MODULE).href)}`,
    "import { existsSync, writeFileSync } from 'node:fs'",
    'const registry = new TestProcessRegistry()',
    'const child = registry.spawn(process.execPath, [\'--input-type=module\', \'--eval\',',
    `  ${JSON.stringify("const { writeFileSync } = await import('node:fs'); writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)")},`,
    `  ${JSON.stringify(fixturePidFile)}], { stdio: 'ignore', windowsHide: true })`,
    `writeFileSync(${JSON.stringify(wrapperPidFile)}, String(child.pid))`,
    `while (!existsSync(${JSON.stringify(fixturePidFile)})) {`,
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)',
    '}',
    '// Simulate a worker termination that cannot run its afterEach hooks.',
    'process.exit(0)',
    '',
  ].join('\n'))

  const result = spawnSync(process.execPath, [supervisor], {
    encoding: 'utf8',
    timeout: PROCESS_TEST_TIMEOUT_MS,
    windowsHide: true,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(wrapperPidFile)).toBe(true)
  expect(existsSync(fixturePidFile)).toBe(true)
  const wrapperPid = Number(readFileSync(wrapperPidFile, 'utf8'))
  const fixturePid = Number(readFileSync(fixturePidFile, 'utf8'))
  fixturePids.push(wrapperPid, fixturePid)

  waitUntil(
    () => !operatingSystem.processIsAlive(wrapperPid)
      && !operatingSystem.processIsAlive(fixturePid),
    'fixture process tree survived its test worker',
  )
  // The contract is now proven and these numeric PIDs may be reused immediately on a
  // busy host. Do not let afterEach mistake their next owners for leaked fixtures.
  fixturePids.length = 0
})
