import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import { PROCESS_TEST_TIMEOUT_MS, TestProcessRegistry } from './testProcess.ts'

// Collected on Linux only (tests/platformCoverage.ts): there the adapter makes each
// fixture lead its own process group, so stopping the wrapper's group does not reach it.

// The wrapper and the registry each wait five seconds before SIGKILL, and the registry
// then gives the fixture the same grace again.
const CLEANUP_TEST_TIMEOUT_MS = PROCESS_TEST_TIMEOUT_MS * 2
const fixturePids: number[] = []
let fixtureRoot = ''

// A fixture orphaned by its wrapper's death may stay a zombie where nothing reaps it, as
// under a container's shell, and a signal probe still finds a zombie. Its state does not.
function isRunning(pid: number): boolean {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return false
  }
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + PROCESS_TEST_TIMEOUT_MS
  while (!existsSync(path) || readFileSync(path, 'utf8') === '') {
    if (Date.now() >= deadline) throw new Error(`${path} was never written`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return readFileSync(path, 'utf8')
}

afterEach(() => {
  for (const pid of fixturePids.splice(0)) {
    if (operatingSystem.processTreeIsAlive(pid)) operatingSystem.terminateProcessTree(pid)
  }
  if (fixtureRoot !== '') rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

it('ends a fixture that ignores SIGTERM for longer than the grace before cleanup returns', async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orch-posix-test-process-'))
  const readyFile = join(fixtureRoot, 'fixture.pid')
  const registry = new TestProcessRegistry()
  registry.spawn(process.execPath, ['--input-type=module', '--eval', [
    "const { writeFileSync } = await import('node:fs')",
    "process.on('SIGTERM', () => {})",
    'writeFileSync(process.argv[1], String(process.pid))',
    'setInterval(() => {}, 1000)',
  ].join('\n'), readyFile], { stdio: 'ignore', windowsHide: true })
  const fixturePid = Number(await waitForFile(readyFile))
  fixturePids.push(fixturePid)

  await registry.cleanup()

  // Checked once, with no wait: cleanup must not report success while the fixture lives.
  expect(isRunning(fixturePid)).toBe(false)
  expect(operatingSystem.processTreeIsAlive(fixturePid)).toBe(false)
  fixturePids.length = 0
}, CLEANUP_TEST_TIMEOUT_MS)

it('ends a fixture whose wrapper is killed while stopping it, before cleanup returns', async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orch-posix-test-process-'))
  const readyFile = join(fixtureRoot, 'fixture.pid')
  const registry = new TestProcessRegistry()
  const wrapper = registry.spawn(process.execPath, ['--input-type=module', '--eval', [
    "const { writeFileSync } = await import('node:fs')",
    "process.on('SIGTERM', () => {})",
    'writeFileSync(process.argv[1], String(process.pid))',
    'setInterval(() => {}, 1000)',
  ].join('\n'), readyFile], { stdio: 'ignore', windowsHide: true })
  const fixturePid = Number(await waitForFile(readyFile))
  fixturePids.push(fixturePid)
  const wrapperClosed = new Promise((resolve) => wrapper.once('close', resolve))

  // The order the race can take: the wrapper starts its five-second stop of the fixture,
  // and a SIGKILL ends the wrapper before that stop reaches its own SIGKILL.
  wrapper.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 200))
  wrapper.kill('SIGKILL')
  await wrapperClosed
  expect(isRunning(fixturePid)).toBe(true)

  await registry.cleanup()

  expect(isRunning(fixturePid)).toBe(false)
  expect(operatingSystem.processTreeIsAlive(fixturePid)).toBe(false)
  fixturePids.length = 0
}, CLEANUP_TEST_TIMEOUT_MS)

it('ends a fixture blocked in a synchronous child, and that child, before cleanup returns', async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orch-posix-test-process-'))
  const fixtureFile = join(fixtureRoot, 'fixture.pid')
  const childFile = join(fixtureRoot, 'child.pid')
  const registry = new TestProcessRegistry()
  const child = [
    "const { writeFileSync } = require('node:fs')",
    "process.on('SIGTERM', () => {})",
    'writeFileSync(process.argv[1], String(process.pid))',
    'setInterval(() => {}, 1000)',
  ].join('\n')
  registry.spawn(process.execPath, ['--input-type=module', '--eval', [
    "const { spawnSync } = await import('node:child_process')",
    "const { writeFileSync } = await import('node:fs')",
    // The handler never runs while spawnSync blocks the event loop.
    "process.on('SIGTERM', () => {})",
    'writeFileSync(process.argv[1], String(process.pid))',
    `spawnSync(process.execPath, ['--eval', ${JSON.stringify(child)}, process.argv[2]], { stdio: 'ignore' })`,
    'setInterval(() => {}, 1000)',
  ].join('\n'), fixtureFile, childFile], { stdio: 'ignore', windowsHide: true })
  const fixturePid = Number(await waitForFile(fixtureFile))
  const childPid = Number(await waitForFile(childFile))
  fixturePids.push(fixturePid)

  await registry.cleanup()

  expect(isRunning(fixturePid)).toBe(false)
  expect(isRunning(childPid)).toBe(false)
  expect(operatingSystem.processTreeIsAlive(fixturePid)).toBe(false)
  fixturePids.length = 0
}, CLEANUP_TEST_TIMEOUT_MS)
