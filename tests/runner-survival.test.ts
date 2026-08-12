import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'

const RUNNER_MODULE = pathToFileURL(join(
  import.meta.dirname, '..', 'src', 'adapters', 'runner-codex.ts',
)).href

type WindowsHideMode = 'absent' | 'true'

interface WindowsConsoleProbe {
  visibility: 'visible' | 'hidden' | 'none'
  consoleProcessCount: number
}

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

async function removeFixture(root: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (existsSync(root)) {
    try {
      operatingSystem.removeDirectory(root)
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

async function runSurvivalScenario(
  windowsHideMode: WindowsHideMode,
): Promise<WindowsConsoleProbe | undefined> {
  const root = mkdtempSync(join(tmpdir(), 'orch-runner-survival-'))
  const bin = join(root, 'bin')
  const codex = join(bin, 'codex')
  const consoleProbe = join(root, 'console-probe.ps1')
  const daemonPidFile = join(root, 'daemon.pid')
  const runnerPidFile = join(root, 'runner.pid')
  const childPidFile = join(root, 'child.pid')
  const visibilityFile = join(root, 'visibility.txt')
  const logFile = join(root, 'runner.log')
  const finalMessageFile = join(root, 'final-message.txt')
  const specFile = join(root, 'task.md')
  let daemonPid = 0
  let runnerPid = 0
  let childPid = 0
  let daemonOutput = ''

  try {
    mkdirSync(bin)
    writeFileSync(consoleProbe, [
      "Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class ConsoleVisibilityProbe {',
      '  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
      '  [DllImport("kernel32.dll", SetLastError = true)]',
      '  public static extern uint GetConsoleProcessList(uint[] processList, uint processCount);',
      '  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]',
      '  public static extern bool IsWindowVisible(IntPtr window);',
      '}',
      "'@",
      '$window = [ConsoleVisibilityProbe]::GetConsoleWindow()',
      '$visibility = if ($window -eq [IntPtr]::Zero) {',
      "  'none'",
      '} elseif ([ConsoleVisibilityProbe]::IsWindowVisible($window)) {',
      "  'visible'",
      '} else {',
      "  'hidden'",
      '}',
      '$processList = New-Object uint32[] 64',
      '$processCount = [ConsoleVisibilityProbe]::GetConsoleProcessList($processList, $processList.Length)',
      "$result = @{ visibility = $visibility; consoleProcessCount = $processCount } | ConvertTo-Json -Compress",
      '[IO.File]::WriteAllText($env:ORCH_TEST_VISIBILITY_FILE, $result)',
      'while ($true) { Start-Sleep -Seconds 1 }',
      '',
    ].join('\n'))
    writeFileSync(codex, [
      '#!/usr/bin/env node',
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const isWindows = process.platform === 'win32'",
      "const command = isWindows ? 'powershell.exe' : process.execPath",
      'const args = isWindows',
      "  ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', process.env.ORCH_TEST_CONSOLE_PROBE]",
      "  : ['-e', 'setInterval(() => {}, 1000)']",
      "const child = spawn(command, args, { stdio: 'ignore' })",
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
      "const runnerOptions = process.env.ORCH_TEST_WINDOWS_HIDE_MODE === 'true'",
      '  ? { windowsHide: true }',
      '  : {}',
      'const pid = await createCodexRunner(runnerOptions).start({',
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
        ORCH_TEST_CONSOLE_PROBE: consoleProbe,
        ORCH_TEST_DAEMON_PID_FILE: daemonPidFile,
        ORCH_TEST_FINAL_MESSAGE_FILE: finalMessageFile,
        ORCH_TEST_LOG_FILE: logFile,
        ORCH_TEST_ROOT: root,
        ORCH_TEST_RUNNER_MODULE: RUNNER_MODULE,
        ORCH_TEST_RUNNER_PID_FILE: runnerPidFile,
        ORCH_TEST_SPEC_FILE: specFile,
        ORCH_TEST_VISIBILITY_FILE: visibilityFile,
        ORCH_TEST_WINDOWS_HIDE_MODE: windowsHideMode,
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
        () => existsSync(runnerPidFile) && existsSync(childPidFile)
          && (process.platform !== 'win32' || existsSync(visibilityFile)),
        'runner tree did not publish its probe results',
      )
    } catch (error) {
      const outputs = [
        daemonOutput.trim(),
        existsSync(logFile) ? readFileSync(logFile, 'utf8').trim() : '',
      ].filter((output) => output !== '').join(': ')
      throw new Error(`${(error as Error).message}${outputs === '' ? '' : `: ${outputs}`}`)
    }
    daemonPid = Number(readFileSync(daemonPidFile, 'utf8'))
    runnerPid = Number(readFileSync(runnerPidFile, 'utf8'))
    childPid = Number(readFileSync(childPidFile, 'utf8'))
    await waitUntil(() => !processIsAlive(daemonPid), 'daemon did not exit')

    expect(processIsAlive(runnerPid)).toBe(true)
    expect(processIsAlive(childPid)).toBe(true)
    const visibility = process.platform === 'win32'
      ? JSON.parse(readFileSync(visibilityFile, 'utf8')) as WindowsConsoleProbe
      : undefined

    terminateProcessTree(runnerPid)
    await waitUntil(
      () => !processIsAlive(runnerPid) && !processIsAlive(childPid),
      'runner process tree did not stop',
    )
    return visibility
  } finally {
    terminateProcessTree(runnerPid)
    terminateProcessTree(daemonPid)
    if (childPid > 0 && processIsAlive(childPid)) {
      try { process.kill(childPid, 'SIGKILL') } catch { /* already gone */ }
    }
    await removeFixture(root)
  }
}

it('keeps the production runner tree hidden, surviving, and terminable', async () => {
  const productionVisibility = await runSurvivalScenario('absent')
  if (process.platform !== 'win32') return

  const windowsHideVisibility = await runSurvivalScenario('true')
  expect(productionVisibility?.visibility).toBe('hidden')
  expect(windowsHideVisibility?.visibility).toBe('hidden')
  expect(productionVisibility?.consoleProcessCount).toBeGreaterThan(1)
  expect(windowsHideVisibility?.consoleProcessCount).toBeGreaterThan(1)
})
