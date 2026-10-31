import {
  execSync, spawn, spawnSync, type ExecSyncOptionsWithStringEncoding, type StdioOptions,
} from 'node:child_process'
import { writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { operatingSystem } from './adapters/os.ts'
import { projectCommandEnvironment } from './internalEnvironment.ts'

const TIMED_SHELL_SUPERVISOR = '--timed-shell-supervisor'
/** The descriptor on which the supervisor reports that the time limit expired. */
const TIMEOUT_REPORT_FD = 3
const TIMEOUT_REPORT = 'timed-out'

/** Execute a project command without exposing the core's private process metadata. */
export function execShellSync(
  command: string,
  options: ExecSyncOptionsWithStringEncoding,
): string {
  const env = projectCommandEnvironment(options.env ?? process.env, operatingSystem)
  if (options.timeout === undefined || options.timeout <= 0) {
    return execSync(command, { ...options, env })
  }
  return execTimedShellSync(command, options.timeout, { ...options, env })
}

function stdioArray(stdio: StdioOptions | undefined): unknown[] {
  if (Array.isArray(stdio)) return [...stdio]
  const each = stdio ?? 'pipe'
  return [each, each, each]
}

/**
 * execSync's own timeout kills only the shell. On Windows that is cmd.exe, which never
 * execs the command, and on POSIX a compound command keeps its own children, so the
 * command it started outlives the limit. A supervisor process owns the shell instead and,
 * when the limit expires, stops the shell's whole process tree through the os adapter.
 */
function execTimedShellSync(
  command: string,
  timeout: number,
  options: ExecSyncOptionsWithStringEncoding,
): string {
  const stdio = stdioArray(options.stdio).slice(0, 3)
  const result = spawnSync(process.execPath, [
    fileURLToPath(import.meta.url), TIMED_SHELL_SUPERVISOR, String(timeout), command,
  ], {
    cwd: options.cwd,
    env: options.env,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
    stdio: [...stdio, 'pipe'] as StdioOptions,
    windowsHide: options.windowsHide,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const timedOut = String(result.output?.[TIMEOUT_REPORT_FD] ?? '').includes(TIMEOUT_REPORT)
  if (result.error === undefined && !timedOut && result.status === 0) return stdout

  // The thrown value keeps execSync's shape, so callers read status and output as before.
  const failure = result.error ?? new Error(timedOut
    ? `Command timed out after ${timeout} ms: ${command}`
    : `Command failed: ${command}${stderr === '' ? '' : `\n${stderr}`}`)
  throw Object.assign(failure, {
    ...(timedOut ? { code: 'ETIMEDOUT' } : {}),
    status: timedOut ? null : result.status,
    signal: timedOut ? 'SIGTERM' : result.signal,
    stdout,
    stderr,
  })
}

function superviseTimedShell(timeout: number, command: string): void {
  // The os adapter supplies the spawn options its process-tree termination relies on.
  const child = spawn(command, {
    ...operatingSystem.terminableSpawnOptions(),
    shell: true,
    stdio: ['inherit', 'inherit', 'inherit'],
    windowsHide: true,
  })
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) operatingSystem.terminateProcessTree(child.pid)
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`)
    }
    writeSync(TIMEOUT_REPORT_FD, TIMEOUT_REPORT)
    process.exit(1)
  }, timeout)
  child.on('error', (error) => {
    clearTimeout(timer)
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    if (signal !== null) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })
}

if (process.argv[2] === TIMED_SHELL_SUPERVISOR) {
  superviseTimedShell(Number(process.argv[3]), process.argv[4] ?? '')
}
