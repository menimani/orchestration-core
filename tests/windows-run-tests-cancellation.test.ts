import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

// This assertion launches PowerShell and depends on Windows process-tree semantics.
// vitest.config.ts leaves the file uncollected off Windows; see platformCoverage.ts.

const fixtures: string[] = []
const processRoots: number[] = []

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{
  status: number | null
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'] as const,
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stderr }))
  })
}

afterEach(() => {
  for (const pid of processRoots.splice(0)) {
    if (!processIsAlive(pid)) continue
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      if (processIsAlive(pid)) throw new Error(`Could not stop test process tree ${pid}`)
    }
  }
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

it('terminates Vitest and releases its lock when the invoking PowerShell exits', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-run-tests-cancel-'))
  fixtures.push(fixture)
  const scripts = join(fixture, 'scripts')
  const vitest = join(fixture, 'node_modules', 'vitest')
  const startedFile = join(fixture, 'started')
  const completedFile = join(fixture, 'completed')
  const pidFile = join(fixture, 'vitest-pid')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(vitest, { recursive: true })
  writeFileSync(
    join(scripts, 'run-tests.mjs'),
    readFileSync(join(import.meta.dirname, '..', 'scripts', 'run-tests.mjs')),
  )
  writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}\n')
  writeFileSync(join(vitest, 'vitest.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    'if (process.env.ORCHESTRATION_TEST_STARTED_FILE) {',
    '  writeFileSync(process.env.ORCHESTRATION_TEST_PID_FILE, String(process.pid))',
    "  writeFileSync(process.env.ORCHESTRATION_TEST_STARTED_FILE, '')",
    '}',
    'await new Promise((resolve) => setTimeout(resolve, Number(process.env.ORCHESTRATION_TEST_DELAY_MS ?? 0)))',
    'if (process.env.ORCHESTRATION_TEST_COMPLETED_FILE) {',
    "  writeFileSync(process.env.ORCHESTRATION_TEST_COMPLETED_FILE, '')",
    '}',
    '',
  ].join('\n'))

  const invoker = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '& $env:ORCHESTRATION_TEST_NODE $env:ORCHESTRATION_TEST_WRAPPER',
  ], {
    cwd: fixture,
    env: {
      ...process.env,
      ORCHESTRATION_TEST_COMPLETED_FILE: completedFile,
      ORCHESTRATION_TEST_DELAY_MS: '2000',
      ORCHESTRATION_TEST_NODE: process.execPath,
      ORCHESTRATION_TEST_PID_FILE: pidFile,
      ORCHESTRATION_TEST_STARTED_FILE: startedFile,
      ORCHESTRATION_TEST_WRAPPER: join(scripts, 'run-tests.mjs'),
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  if (invoker.pid !== undefined) processRoots.push(invoker.pid)
  await waitForPath(startedFile)
  const vitestPid = Number(readFileSync(pidFile, 'utf8'))
  processRoots.push(vitestPid)
  expect(processIsAlive(vitestPid)).toBe(true)

  invoker.kill('SIGKILL')
  await waitUntil(
    () => !processIsAlive(vitestPid),
    `Vitest process ${vitestPid} survived its invoking PowerShell process`,
  )
  await new Promise((resolve) => setTimeout(resolve, 2_100))
  expect(existsSync(completedFile)).toBe(false)

  const contender = await run(
    process.execPath,
    [join(scripts, 'run-tests.mjs')],
    fixture,
    process.env,
  )
  expect(contender.status).toBe(0)
  expect(contender.stderr).toBe('')
})

it('stops a locked waiter when its invoking PowerShell exits', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-run-tests-locked-cancel-'))
  fixtures.push(fixture)
  const scripts = join(fixture, 'scripts')
  const vitest = join(fixture, 'node_modules', 'vitest')
  const invocationFile = join(fixture, 'invocations')
  const waiterPidFile = join(fixture, 'waiter-pid')
  const waitingFile = join(fixture, 'waiting')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(vitest, { recursive: true })
  const wrapper = readFileSync(join(import.meta.dirname, '..', 'scripts', 'run-tests.mjs'), 'utf8')
    .replace(
      'async function runTestSuite() {',
      "async function runTestSuite() {\n  if (process.env.ORCHESTRATION_TEST_WAITER_PID_FILE) writeFileSync(process.env.ORCHESTRATION_TEST_WAITER_PID_FILE, String(process.pid))",
    )
    .replace(
      'console.log(`Another worktree is running the test suite;',
      "if (process.env.ORCHESTRATION_TEST_WAITING_FILE) writeFileSync(process.env.ORCHESTRATION_TEST_WAITING_FILE, '')\n      console.log(`Another worktree is running the test suite;",
    )
  writeFileSync(join(scripts, 'run-tests.mjs'), wrapper)
  writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}\n')
  writeFileSync(join(vitest, 'vitest.mjs'), [
    "import { appendFileSync } from 'node:fs'",
    "appendFileSync(process.env.ORCHESTRATION_TEST_INVOCATION_FILE, `${process.pid}\\n`)",
    '',
  ].join('\n'))
  const lock = join(fixture, '.orchestration-test-suite-lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({
    pid: process.pid,
    token: 'fixture-owner',
  })}\n`)

  const invoker = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '& $env:ORCHESTRATION_TEST_NODE $env:ORCHESTRATION_TEST_WRAPPER',
  ], {
    cwd: fixture,
    env: {
      ...process.env,
      ORCHESTRATION_TEST_INVOCATION_FILE: invocationFile,
      ORCHESTRATION_TEST_NODE: process.execPath,
      ORCHESTRATION_TEST_WAITER_PID_FILE: waiterPidFile,
      ORCHESTRATION_TEST_WAITING_FILE: waitingFile,
      ORCHESTRATION_TEST_WRAPPER: join(scripts, 'run-tests.mjs'),
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  if (invoker.pid !== undefined) processRoots.push(invoker.pid)
  await waitForPath(waiterPidFile)
  const waiterPid = Number(readFileSync(waiterPidFile, 'utf8'))
  processRoots.push(waiterPid)
  expect(processIsAlive(waiterPid)).toBe(true)
  await waitForPath(waitingFile)

  invoker.kill('SIGKILL')
  await waitUntil(
    () => !processIsAlive(waiterPid),
    `Test wrapper ${waiterPid} survived its invoking PowerShell process while waiting for the lock`,
  )
  rmSync(lock, { recursive: true, force: true })
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(existsSync(invocationFile)).toBe(false)
})
