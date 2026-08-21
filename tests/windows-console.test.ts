import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import {
  startWindowsProcess, WINDOWS_PROCESS_ROOT_PID_ENV,
} from '../src/adapters/windows-process.ts'
import { PROCESS_TEST_TIMEOUT_MS } from './testProcess.ts'

// Windows console and window behaviour is what this asserts, so there is nothing for
// another platform to run. vitest.config.ts leaves the file uncollected off Windows
// rather than collecting it and reporting a skip, which reads as a disabled test.

const fixtureRoots: string[] = []
const processRoots: number[] = []

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TEST_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function removeWhenReleased(root: string): Promise<void> {
  await waitUntil(() => {
    try {
      operatingSystem.removeDirectory(root)
      return true
    } catch {
      return false
    }
  }, `Windows did not release fixture directory ${root}`)
}

afterEach(async () => {
  for (const pid of processRoots.splice(0)) {
    if (operatingSystem.processIsAlive(pid)) operatingSystem.terminateProcessTree(pid)
  }
  for (const root of fixtureRoots.splice(0)) await removeWhenReleased(root)
})

it(
  'starts a surviving process tree whose console descendants share one hidden window',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'orchestration-hidden-console-'))
    fixtureRoots.push(root)
    const targetDir = join(root, 'target files')
    mkdirSync(targetDir)
    const targetFile = join(targetDir, 'target.cjs')
    const inputFile = join(root, 'input.txt')
    const outputFile = join(root, 'output.log')
    const resultBase = join(root, 'console')
    const resultsReadyFile = join(root, 'console.ready')
    const targetPidFile = join(root, 'target.pid')
    const rootPidFile = join(root, 'root.pid')

    const consoleProbe = [
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class ConsoleProbe {',
      '  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);',
      '}',
      '"@',
      '$handle = [ConsoleProbe]::GetConsoleWindow()',
      '@{ pid=$PID; console=$handle.ToInt64(); visible=[ConsoleProbe]::IsWindowVisible($handle) } | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:ORCH_TEST_CONSOLE_RESULT -Encoding ascii',
    ].join('\n')
    const encodedProbe = Buffer.from(consoleProbe, 'utf16le').toString('base64')
    writeFileSync(targetFile, [
      "const { spawnSync } = require('node:child_process')",
      "const { readFileSync, writeFileSync } = require('node:fs')",
      "writeFileSync(process.env.ORCH_TEST_TARGET_PID, String(process.pid))",
      `writeFileSync(process.env.ORCH_TEST_ROOT_PID, process.env.${WINDOWS_PROCESS_ROOT_PID_ENV})`,
      "console.log(`input:${readFileSync(0, 'utf8')}`)",
      'for (let index = 1; index <= 2; index++) {',
      '  const env = {',
      '    ...process.env,',
      '    ORCH_TEST_CONSOLE_RESULT: `${process.env.ORCH_TEST_RESULT_BASE}.${index}`,',
      '  }',
      "  spawnSync('powershell.exe', [",
      "    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',",
      '    process.env.ORCH_TEST_CONSOLE_PROBE,',
      "  ], { env, stdio: 'ignore' })",
      '}',
      "writeFileSync(process.env.ORCH_TEST_RESULTS_READY, '')",
      'setInterval(() => {}, 1_000)',
      '',
    ].join('\n'))
    writeFileSync(inputFile, 'task specification')

    const pid = await startWindowsProcess({
      args: [targetFile],
      command: process.execPath,
      cwd: root,
      env: {
        ...process.env,
        ORCH_TEST_CONSOLE_PROBE: encodedProbe,
        ORCH_TEST_RESULT_BASE: resultBase,
        ORCH_TEST_RESULTS_READY: resultsReadyFile,
        ORCH_TEST_ROOT_PID: rootPidFile,
        ORCH_TEST_TARGET_PID: targetPidFile,
      },
      inputFile,
      outputFile,
    })
    processRoots.push(pid)

    await waitUntil(
      () => existsSync(resultsReadyFile),
      'console descendants did not publish their observations',
    )
    const first = JSON.parse(readFileSync(`${resultBase}.1`, 'utf8')) as {
      console: number
      visible: boolean
    }
    const second = JSON.parse(readFileSync(`${resultBase}.2`, 'utf8')) as {
      console: number
      visible: boolean
    }

    expect(operatingSystem.processIsAlive(pid)).toBe(true)
    expect(readFileSync(rootPidFile, 'utf8')).toBe(`${pid}`)
    expect(Number(readFileSync(targetPidFile, 'utf8'))).not.toBe(pid)
    expect(first.console).toBeGreaterThan(0)
    expect(second.console).toBe(first.console)
    expect(first.visible).toBe(false)
    expect(second.visible).toBe(false)
    expect(readFileSync(outputFile, 'utf8')).toContain('input:task specification')
  },
)
