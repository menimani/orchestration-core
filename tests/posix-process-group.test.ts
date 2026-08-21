import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createOperatingSystem } from '../src/adapters/os-posix.ts'
import { PROCESS_TEST_TIMEOUT_MS } from './testProcess.ts'

// The POSIX counterpart of windows-console.test.ts. Every other test of this adapter
// injects its runtime, which proves the decisions it makes but not that a real signal
// reaches a real process group: `process.kill(-pid)` and reading `/proc/<pid>/stat` are
// answered by the kernel, and no injected runtime can stand in for that. Windows had
// such a test and POSIX did not, so the behaviour a merged fix repaired here — killing a
// daemon's whole process group rather than the daemon alone — was never exercised for
// real. vitest.config.ts collects this on POSIX alone; see tests/platformCoverage.ts.

const roots: string[] = []
const groups: number[] = []
const operatingSystem = createOperatingSystem()

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TEST_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  for (const pid of groups.splice(0)) {
    try {
      if (operatingSystem.processTreeIsAlive(pid)) process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone, which is what the test asked for.
    }
  }
  for (const root of roots.splice(0)) operatingSystem.removeDirectory(root)
})

it('terminates every member of a detached process group, not only its leader', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-process-group-'))
  roots.push(root)
  const outputFile = join(root, 'daemon.log')
  const leaderPidFile = join(root, 'leader.pid')
  const childPidFile = join(root, 'child.pid')
  const readyFile = join(root, 'ready')

  // The leader forks a child that outlives a signal sent to the leader alone, so a
  // termination that reached only the leader leaves the child running and observable.
  const script = join(root, 'leader.cjs')
  writeFileSync(script, `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: false,
  stdio: 'ignore',
})
writeFileSync(${JSON.stringify(leaderPidFile)}, String(process.pid))
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))
writeFileSync(${JSON.stringify(readyFile)}, '')
setInterval(() => {}, 1000)
`)

  const daemon = await operatingSystem.launchDaemon({
    args: [script],
    command: process.execPath,
    cwd: root,
    env: process.env,
    outputFile,
  })
  groups.push(daemon.pid)
  daemon.release()

  await waitUntil(() => existsSync(readyFile), 'the detached leader never started its child')
  const leaderPid = Number(readFileSync(leaderPidFile, 'utf8'))
  const childPid = Number(readFileSync(childPidFile, 'utf8'))

  expect(leaderPid).toBe(daemon.pid)
  expect(childPid).not.toBe(daemon.pid)
  expect(operatingSystem.processIsAlive(childPid)).toBe(true)
  expect(operatingSystem.processTreeIsAlive(daemon.pid)).toBe(true)

  expect(operatingSystem.terminateProcessTree(daemon.pid)).toBe(true)

  // The forked child is what proves group-wide delivery: it was never signalled
  // directly, so a signal that reached only the leader leaves it running here. It is a
  // grandchild of this process, reparented to init and reaped there, so wait for the
  // PID to disappear rather than assuming reaping already happened.
  await waitUntil(
    () => !operatingSystem.processIsAlive(childPid),
    'the forked child outlived a signal sent to its process group',
  )

  // The group reports empty, which is the contract terminateProcessTree returned true
  // for. `processIsAlive(leaderPid)` is deliberately not asserted: the leader is a child
  // of this test process, so between its death and this process reaping it the PID still
  // answers `kill(pid, 0)` as a zombie. `groupHasRunningMember` excludes state Z for that
  // reason, and it is the check the adapter itself trusts.
  expect(operatingSystem.processTreeIsAlive(daemon.pid)).toBe(false)
})
