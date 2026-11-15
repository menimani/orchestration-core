import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import { PROCESS_TEST_TIMEOUT_MS } from './testProcess.ts'

// Every other test of the adapters injects a runtime, which proves the decisions they
// make but not that a real stop reaches a real process tree: POSIX signals a process
// group and reads `/proc/<pid>/stat`, Windows follows parent links and runs taskkill,
// and only the operating system answers either. The behaviour a merged fix repaired —
// stopping a daemon's whole tree rather than the daemon alone — runs here on every
// platform, through the adapter the platform selects.

const roots: string[] = []
const trees: number[] = []

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TEST_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Windows can still hold a stopped process's files for a moment after it reports the
// process gone, so removal is retried until the deadline rather than attempted once.
async function removeWhenReleased(root: string): Promise<void> {
  await waitUntil(() => {
    try {
      operatingSystem.removeDirectory(root)
      return true
    } catch {
      return false
    }
  }, `the operating system did not release fixture directory ${root}`)
}

afterEach(async () => {
  for (const pid of trees.splice(0)) {
    if (operatingSystem.processTreeIsAlive(pid)) operatingSystem.terminateProcessTree(pid)
  }
  for (const root of roots.splice(0)) await removeWhenReleased(root)
})

it('terminates every member of a daemon process tree, not only its root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-process-tree-'))
  roots.push(root)
  const outputFile = join(root, 'daemon.log')
  const leaderPidFile = join(root, 'leader.pid')
  const childPidFile = join(root, 'child.pid')
  const readyFile = join(root, 'ready')

  // The leader starts a child that outlives a stop sent to the leader alone, so a
  // termination that reached only the leader leaves the child running and observable.
  const script = join(root, 'leader.cjs')
  writeFileSync(script, `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: false,
  stdio: 'ignore',
  windowsHide: true,
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
  trees.push(daemon.pid)
  daemon.release()

  await waitUntil(() => existsSync(readyFile), 'the daemon never started its child')
  const leaderPid = Number(readFileSync(leaderPidFile, 'utf8'))
  const childPid = Number(readFileSync(childPidFile, 'utf8'))

  // POSIX launches the leader itself as the root of its group. Windows launches it
  // through a hidden-console launcher, so there the leader is a descendant of the root.
  if (process.platform !== 'win32') expect(leaderPid).toBe(daemon.pid)
  expect(childPid).not.toBe(daemon.pid)
  expect(childPid).not.toBe(leaderPid)
  expect(operatingSystem.processIsAlive(childPid)).toBe(true)
  expect(operatingSystem.processTreeIsAlive(daemon.pid)).toBe(true)

  expect(operatingSystem.terminateProcessTree(daemon.pid)).toBe(true)

  // The child is what proves tree-wide delivery: it was never stopped directly, so a
  // stop that reached only the leader leaves it running here. On POSIX it is a
  // grandchild of this process, reparented to init and reaped there, so wait for the
  // PID to disappear rather than assuming reaping already happened.
  await waitUntil(
    () => !operatingSystem.processIsAlive(childPid),
    'the child outlived the termination of its process tree',
  )

  // The tree reports empty, which is the contract terminateProcessTree returned true
  // for. `processIsAlive(leaderPid)` is deliberately not asserted: on POSIX the leader
  // is a child of this test process, so between its death and this process reaping it
  // the PID still answers `kill(pid, 0)` as a zombie. `groupHasRunningMember` excludes
  // state Z for that reason, and it is the check the adapter itself trusts.
  expect(operatingSystem.processTreeIsAlive(daemon.pid)).toBe(false)
  // The proof is complete and the PID may be reused at once on a busy host; do not let
  // afterEach mistake its next owner for a leaked tree.
  trees.length = 0
})
