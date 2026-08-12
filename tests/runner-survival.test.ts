import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const RUNNER_MODULE = pathToFileURL(join(
  import.meta.dirname, '..', 'src', 'adapters', 'runner-codex.ts',
)).href

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function terminateProcessTree(pid: number): void {
  if (!processIsAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The detached process group may have exited between the probe and signal.
  }
}

it('keeps a runner alive after the daemon exits and leaves its tree terminable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-runner-survival-'))
  const bin = join(root, 'bin')
  const codex = join(bin, 'codex')
  const daemonPidFile = join(root, 'daemon.pid')
  const runnerPidFile = join(root, 'runner.pid')
  const childPidFile = join(root, 'child.pid')
  const logFile = join(root, 'runner.log')
  const finalMessageFile = join(root, 'final-message.txt')
  const specFile = join(root, 'task.md')
  let daemonPid = 0
  let runnerPid = 0
  let childPid = 0
  let daemonOutput = ''

  try {
    mkdirSync(bin)
    writeFileSync(codex, [
      '#!/usr/bin/env node',
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "writeFileSync(process.env.ORCH_TEST_CHILD_PID_FILE, String(child.pid))",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))
    chmodSync(codex, 0o755)
    writeFileSync(specFile, 'test runner survival')

    const daemonSource = [
      "const { writeFileSync } = await import('node:fs')",
      'const { createCodexRunner } = await import(process.env.ORCH_TEST_RUNNER_MODULE)',
      "writeFileSync(process.env.ORCH_TEST_DAEMON_PID_FILE, String(process.pid))",
      'const pid = await createCodexRunner().start({',
      "  effort: 'low',",
      '  finalMessageFile: process.env.ORCH_TEST_FINAL_MESSAGE_FILE,',
      '  logFile: process.env.ORCH_TEST_LOG_FILE,',
      '  specFile: process.env.ORCH_TEST_SPEC_FILE,',
      '  worktree: process.env.ORCH_TEST_ROOT,',
      '})',
      'writeFileSync(process.env.ORCH_TEST_RUNNER_PID_FILE, String(pid))',
    ].join('\n')
    const daemon = spawn(process.execPath, ['--input-type=module', '--eval', daemonSource], {
      detached: true,
      env: {
        ...process.env,
        ORCH_TEST_CHILD_PID_FILE: childPidFile,
        ORCH_TEST_DAEMON_PID_FILE: daemonPidFile,
        ORCH_TEST_FINAL_MESSAGE_FILE: finalMessageFile,
        ORCH_TEST_LOG_FILE: logFile,
        ORCH_TEST_ROOT: root,
        ORCH_TEST_RUNNER_MODULE: RUNNER_MODULE,
        ORCH_TEST_RUNNER_PID_FILE: runnerPidFile,
        ORCH_TEST_SPEC_FILE: specFile,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    daemon.stdout?.on('data', (chunk: Buffer) => { daemonOutput += chunk.toString() })
    daemon.stderr?.on('data', (chunk: Buffer) => { daemonOutput += chunk.toString() })
    daemonPid = daemon.pid ?? 0
    expect(daemonPid).toBeGreaterThan(0)
    daemon.unref()

    try {
      await waitUntil(
        () => existsSync(runnerPidFile) && existsSync(childPidFile),
        'runner tree did not publish its PIDs',
      )
    } catch (error) {
      const detail = daemonOutput.trim()
      throw new Error(`${(error as Error).message}${detail === '' ? '' : `: ${detail}`}`)
    }
    daemonPid = Number(readFileSync(daemonPidFile, 'utf8'))
    runnerPid = Number(readFileSync(runnerPidFile, 'utf8'))
    childPid = Number(readFileSync(childPidFile, 'utf8'))
    await waitUntil(() => !processIsAlive(daemonPid), 'daemon did not exit')

    expect(processIsAlive(runnerPid)).toBe(true)
    expect(processIsAlive(childPid)).toBe(true)

    terminateProcessTree(runnerPid)
    await waitUntil(
      () => !processIsAlive(runnerPid) && !processIsAlive(childPid),
      'runner process tree did not stop',
    )
  } finally {
    terminateProcessTree(runnerPid)
    terminateProcessTree(daemonPid)
    if (childPid > 0 && processIsAlive(childPid)) {
      try { process.kill(childPid, 'SIGKILL') } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})
