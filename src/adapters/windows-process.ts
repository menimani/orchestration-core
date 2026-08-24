import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOWS_PROCESS_ROOT_PID_ENV } from '../internalEnvironment.ts'

export { WINDOWS_PROCESS_ROOT_PID_ENV } from '../internalEnvironment.ts'

const WINDOWS_LAUNCH_CONFIG_ENV = 'ORCHESTRATION_WINDOWS_LAUNCH_CONFIG'
const WINDOWS_LAUNCH_ERROR_FILE_ENV = 'ORCHESTRATION_WINDOWS_LAUNCH_ERROR_FILE'
const WINDOWS_LAUNCH_TIMEOUT_MS = 10_000
const WINDOWS_LAUNCH_POLL_MS = 10
const WINDOWS_EXIT_TIMEOUT_MS = 5_000
const WINDOWS_EXIT_POLL_MS = 50

export interface WindowsProcessRuntime {
  platform: NodeJS.Platform
  now(): number
  sleep(milliseconds: number): Promise<void>
  spawnLauncher(command: string, args: readonly string[], options: SpawnOptions): ChildProcess
  listProcesses(): readonly WindowsProcess[]
  probeProcess(pid: number): void
  requestLauncherTreeTermination(launcher: ChildProcess): boolean
  removeDirectory(path: string): void
  launchTimeoutMs: number
  launchPollMs: number
}

export interface WindowsProcess {
  pid: number
  parentPid: number
}

interface WindowsProcessDescriptor {
  args: string[]
  command: string
  cwd: string
  errorFile: string
  inputFile?: string
  outputFile: string
  readyFile: string
}

export interface WindowsProcessOptions {
  args: readonly string[]
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  inputFile?: string
  outputFile: string
}

interface WindowsLaunchConfig {
  argumentLine: string
  cwd: string
  executable: string
}

// PowerShell's Start-Process accepts one Windows command line rather than an argv array.
// Apply the CommandLineToArgvW quoting rules so package and temporary paths may contain
// spaces, quotes, or trailing backslashes without changing the wrapper's arguments.
export function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument
  let quoted = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes++
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    quoted += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

export function processTreeRootPid(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[WINDOWS_PROCESS_ROOT_PID_ENV]
  if (value !== undefined && /^[1-9][0-9]*$/.test(value)) {
    const pid = Number(value)
    if (Number.isSafeInteger(pid)) return pid
  }
  return process.pid
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split(/\r?\n/, 1)[0] ?? '').trim() || 'unknown error'
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const systemRuntime: WindowsProcessRuntime = {
  platform: process.platform,
  now: Date.now,
  sleep,
  spawnLauncher: (command, args, options) => spawn(command, [...args], options),
  listProcesses: () => {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0},{1}' -f $_.ProcessId,$_.ParentProcessId }",
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error('Could not inspect the Windows startup process tree.')
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = /^(\d+),(\d+)$/.exec(line)
      if (match === null) throw new Error('Could not parse the Windows startup process tree.')
      return { pid: Number(match[1]), parentPid: Number(match[2]) }
    })
  },
  probeProcess: (pid) => {
    process.kill(pid, 0)
  },
  requestLauncherTreeTermination: (launcher) => {
    if (launcher.pid === undefined) return launcher.kill()
    const result = spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return result.status === 0
  },
  removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
  launchTimeoutMs: WINDOWS_LAUNCH_TIMEOUT_MS,
  launchPollMs: WINDOWS_LAUNCH_POLL_MS,
}

function processIsAlive(runtime: WindowsProcessRuntime, pid: number): boolean {
  try {
    runtime.probeProcess(pid)
    return true
  } catch (error) {
    // A permission or other probe failure does not prove that the process stopped.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function launcherTreePids(
  runtime: WindowsProcessRuntime,
  launcherPid: number,
): ReadonlySet<number> {
  const processes = runtime.listProcesses()
  const runningPids = new Set(processes.map(({ pid }) => pid))
  const childrenByParent = new Map<number, number[]>()
  for (const { pid, parentPid } of processes) {
    const children = childrenByParent.get(parentPid) ?? []
    children.push(pid)
    childrenByParent.set(parentPid, children)
  }

  const treePids = new Set<number>()
  const visited = new Set<number>()
  const pending = [launcherPid]
  while (pending.length > 0) {
    const pid = pending.pop()!
    if (visited.has(pid)) continue
    visited.add(pid)
    if (runningPids.has(pid)) treePids.add(pid)
    pending.push(...(childrenByParent.get(pid) ?? []))
  }
  return treePids
}

function anyProcessIsAlive(runtime: WindowsProcessRuntime, pids: ReadonlySet<number>): boolean {
  return [...pids].some((pid) => processIsAlive(runtime, pid))
}

async function terminateLauncherTree(
  runtime: WindowsProcessRuntime,
  launcher: ChildProcess,
): Promise<boolean> {
  if (launcher.pid === undefined) return runtime.requestLauncherTreeTermination(launcher)

  let trackedPids: ReadonlySet<number>
  try {
    trackedPids = launcherTreePids(runtime, launcher.pid)
  } catch {
    // Process enumeration can fail independently of taskkill. The launcher is the
    // only PID available for a direct check in that case; do not trust taskkill's
    // request status or discard the descriptor until that PID is confirmed gone.
    trackedPids = new Set([launcher.pid])
  }
  if (!anyProcessIsAlive(runtime, trackedPids)) return false

  // taskkill's status is only a request result. Descendants can survive after their
  // parent exits, so retain the snapshot and verify every captured PID below.
  runtime.requestLauncherTreeTermination(launcher)
  const deadline = runtime.now() + WINDOWS_EXIT_TIMEOUT_MS
  while (anyProcessIsAlive(runtime, trackedPids) && runtime.now() < deadline) {
    await runtime.sleep(WINDOWS_EXIT_POLL_MS)
  }
  if (anyProcessIsAlive(runtime, trackedPids)) {
    throw new Error(`Could not stop Windows startup process tree ${launcher.pid}.`)
  }
  return true
}

class WindowsStartupProcessRetainedError extends Error {
  constructor(stateDirectory: string, cause: unknown) {
    super(`${errorSummary(cause)} Startup state was retained at ${stateDirectory}.`, { cause })
    this.name = 'WindowsStartupProcessRetainedError'
  }
}

const START_HIDDEN_PROCESS = [
  "$ErrorActionPreference = 'Stop'",
  `$errorFile = $env:${WINDOWS_LAUNCH_ERROR_FILE_ENV}`,
  'try {',
  `  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${WINDOWS_LAUNCH_CONFIG_ENV}))`,
  '  $config = $json | ConvertFrom-Json',
  `  Remove-Item Env:${WINDOWS_LAUNCH_CONFIG_ENV}`,
  `  Remove-Item Env:${WINDOWS_LAUNCH_ERROR_FILE_ENV}`,
  '  Start-Process -FilePath $config.executable -ArgumentList $config.argumentLine -WorkingDirectory $config.cwd -WindowStyle Hidden -Wait | Out-Null',
  '} catch {',
  '  $_.Exception.Message | Set-Content -LiteralPath $errorFile -Encoding utf8',
  '  exit 1',
  '}',
].join('\n')

/**
 * Start an independent Windows process tree with one hidden console.
 *
 * Measured on Windows 11 (2026-08-13): Node's detached flag gave each console
 * descendant a separate visible console whether windowsHide was present or not.
 * Start-Process with WindowStyle Hidden instead created one non-visible console whose
 * handle was shared by repeated descendants, and the process survived its launcher.
 */
export async function startWindowsProcess(
  options: WindowsProcessOptions,
  runtime: WindowsProcessRuntime = systemRuntime,
): Promise<number> {
  if (runtime.platform !== 'win32') {
    throw new Error('The hidden Windows process launcher is available only on Windows.')
  }

  const root = mkdtempSync(join(tmpdir(), 'orchestration-windows-launch-'))
  const descriptorFile = join(root, 'descriptor.json')
  const readyFile = join(root, 'ready')
  const errorFile = join(root, 'error')
  const descriptor: WindowsProcessDescriptor = {
    args: [...options.args],
    command: options.command,
    cwd: options.cwd,
    errorFile,
    outputFile: options.outputFile,
    readyFile,
    ...(options.inputFile === undefined ? {} : { inputFile: options.inputFile }),
  }
  writeFileSync(descriptorFile, JSON.stringify(descriptor))

  const launchConfig: WindowsLaunchConfig = {
    executable: process.execPath,
    argumentLine: [fileURLToPath(import.meta.url), '--windows-process-wrapper', descriptorFile]
      .map(quoteWindowsArgument).join(' '),
    cwd: options.cwd,
  }
  const encodedScript = Buffer.from(START_HIDDEN_PROCESS, 'utf16le').toString('base64')
  const encodedConfig = Buffer.from(JSON.stringify(launchConfig)).toString('base64')
  const launcher = runtime.spawnLauncher('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript,
  ], {
    cwd: options.cwd,
    // This short-lived launcher must execute its script before the caller exits.
    // Detaching Windows PowerShell here was also measured to make it exit without
    // executing EncodedCommand; the independently launched wrapper is the durable root.
    detached: false,
    env: {
      ...(options.env ?? process.env),
      [WINDOWS_LAUNCH_CONFIG_ENV]: encodedConfig,
      [WINDOWS_LAUNCH_ERROR_FILE_ENV]: errorFile,
    },
    stdio: 'ignore',
    windowsHide: true,
  })

  let launcherError: Error | undefined
  let launched = false
  let retainStartupState = false
  launcher.once('error', (error) => { launcherError = error })
  const deadline = runtime.now() + runtime.launchTimeoutMs
  try {
    for (;;) {
      if (existsSync(readyFile)) {
        const value = readFileSync(readyFile, 'utf8').trim()
        if (value !== '' && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
          throw new Error(`Windows process wrapper published an invalid PID (${value || 'empty'})`)
        }
        if (value !== '') {
          launched = true
          launcher.unref()
          return Number(value)
        }
      }
      if (existsSync(errorFile)) {
        throw new Error(readFileSync(errorFile, 'utf8').trim() || 'Windows process launch failed')
      }
      if (launcherError !== undefined) throw launcherError
      if (runtime.now() >= deadline) {
        throw new Error('Windows process wrapper never published a PID before startup timed out')
      }
      await runtime.sleep(runtime.launchPollMs)
    }
  } catch (error) {
    let foundAlive: boolean
    try {
      foundAlive = await terminateLauncherTree(runtime, launcher)
    } catch (cleanupError) {
      retainStartupState = true
      throw new WindowsStartupProcessRetainedError(root, cleanupError)
    }
    const detail = foundAlive ? 'found and terminated a live process tree' : 'found no live process tree'
    throw new Error(`${errorSummary(error)}; startup cleanup ${detail}`, { cause: error })
  } finally {
    if (!launched) launcher.kill()
    if (!retainStartupState) {
      try {
        runtime.removeDirectory(root)
      } catch (error) {
        // Once the wrapper PID has been published, cleanup must not turn a live process
        // into an unregistered launch. The OS temporary directory can be reclaimed later.
        if (!launched) throw error
      }
    }
  }
}

async function runWindowsProcessWrapper(descriptorFile: string): Promise<void> {
  let descriptor: WindowsProcessDescriptor
  try {
    descriptor = JSON.parse(readFileSync(descriptorFile, 'utf8')) as WindowsProcessDescriptor
  } catch (error) {
    process.exitCode = 1
    return
  }

  let inputFd: number | undefined
  let outputFd: number | undefined
  const closeDescriptors = (): void => {
    if (inputFd !== undefined) closeSync(inputFd)
    if (outputFd !== undefined) closeSync(outputFd)
    inputFd = undefined
    outputFd = undefined
  }
  try {
    if (descriptor.inputFile !== undefined) inputFd = openSync(descriptor.inputFile, 'r')
    outputFd = openSync(descriptor.outputFile, 'a')
    const child = spawn(descriptor.command, descriptor.args, {
      cwd: descriptor.cwd,
      detached: false,
      env: {
        ...process.env,
        [WINDOWS_PROCESS_ROOT_PID_ENV]: `${process.pid}`,
      },
      stdio: [inputFd ?? 'ignore', outputFd, outputFd],
    })
    child.once('error', (error) => {
      closeDescriptors()
      writeFileSync(descriptor.errorFile, errorSummary(error))
      process.exitCode = 1
    })
    child.once('spawn', () => {
      closeDescriptors()
      writeFileSync(descriptor.readyFile, `${process.pid}\n`, { flag: 'wx' })
    })
    child.once('exit', (code) => {
      process.exitCode = code ?? 1
    })
  } catch (error) {
    closeDescriptors()
    writeFileSync(descriptor.errorFile, errorSummary(error))
    process.exitCode = 1
  }
}

if (process.argv[2] === '--windows-process-wrapper') {
  const descriptorFile = process.argv[3]
  if (descriptorFile === undefined) process.exitCode = 1
  else await runWindowsProcessWrapper(descriptorFile)
}
