import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  operatingSystem, type DaemonProcess, type OperatingSystem,
} from './adapters/os.ts'
import { PACKAGE_ROOT } from './paths.ts'
import {
  LOOP_RESTART_PREDECESSOR_PID_ENV, LOOP_RESTART_READY_FILE_ENV,
} from './internalEnvironment.ts'
import {
  currentProcessMarkerPid, parseProcessMarker, processMarker, processMarkerText,
} from './processMarker.ts'

export {
  LOOP_RESTART_PREDECESSOR_PID_ENV, LOOP_RESTART_READY_FILE_ENV,
} from './internalEnvironment.ts'

export interface LoopRestartCommand {
  executable: string
  args: string[]
  cwd: string
}

export interface LoopRestartResult {
  ok: boolean
  pid?: number
  error?: string
}

interface LoopRestartRuntime {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  onReady?: (pid: number) => void
  operatingSystem?: OperatingSystem
  outputFile?: string
  packageRoot?: string
  startupTimeoutMs?: number
}

/** Identify the live daemon whose PID reservation a replacement is allowed to use. */
export function loopRestartPredecessorPid(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const value = env[LOOP_RESTART_PREDECESSOR_PID_ENV]
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const pid = Number(value)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** Atomically replace a live predecessor's PID reservation with its ready replacement. */
export function publishLoopReplacementPid(
  pidFile: string,
  predecessorPid: number,
  replacementPid: number,
): void {
  const ownerText = readFileSync(pidFile, 'utf8')
  const owner = parseProcessMarker(ownerText)
  // A replacement started by a legacy predecessor must leave its bare reservation
  // untouched until that predecessor completes the handover. The replacement can then
  // upgrade that inherited reservation safely on its next current-version restart.
  if (currentProcessMarkerPid(ownerText) !== predecessorPid) {
    throw new Error(`loop PID owner changed before restart handover (${owner?.pid ?? 'invalid'})`)
  }
  const candidate = `${pidFile}.handover-${predecessorPid}-${replacementPid}-${randomUUID()}`
  try {
    writeFileSync(candidate, processMarkerText(processMarker(replacementPid)), { flag: 'wx' })
    renameSync(candidate, pidFile)
  } finally {
    rmSync(candidate, { force: true })
  }
}

/** Resolve re-execution from the installed package, never from the invocation spelling. */
export function loopRestartCommand(
  argv: string[] = process.argv,
  packageRoot: string = PACKAGE_ROOT,
): LoopRestartCommand {
  return {
    executable: process.execPath,
    args: [join(packageRoot, 'src', 'cli.ts'), ...argv.slice(2)],
    cwd: packageRoot,
  }
}

/** The replacement publishes readiness only after daemon initialization has completed. */
export function signalLoopRestartReady(
  env: NodeJS.ProcessEnv = process.env,
  os: OperatingSystem = operatingSystem,
): void {
  const readyFile = env[LOOP_RESTART_READY_FILE_ENV]
  try {
    if (readyFile === undefined || readyFile === '') return
    writeFileSync(readyFile, `${os.processTreeRootPid(env)}\n`, { flag: 'wx' })
  } finally {
    delete env[LOOP_RESTART_READY_FILE_ENV]
    delete env[LOOP_RESTART_PREDECESSOR_PID_ENV]
  }
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split(/\r?\n/, 1)[0] ?? '').trim() || 'unknown error'
}

/** Start the replacement and wait for its explicit ready signal before reporting success. */
export async function startLoopReplacement(
  readyFile: string,
  runtime: LoopRestartRuntime = {},
): Promise<LoopRestartResult> {
  rmSync(readyFile, { force: true })
  const command = loopRestartCommand(runtime.argv, runtime.packageRoot)
  const os = runtime.operatingSystem ?? operatingSystem
  const predecessorPid = os.processTreeRootPid(runtime.env ?? process.env)
  let replacement: DaemonProcess
  try {
    const env = {
      ...(runtime.env ?? process.env),
      [LOOP_RESTART_READY_FILE_ENV]: readyFile,
      [LOOP_RESTART_PREDECESSOR_PID_ENV]: `${predecessorPid}`,
    }
    if (runtime.outputFile === undefined) throw new Error('A loop log file is required to restart the daemon')
    replacement = await os.launchDaemon({
      args: command.args,
      command: command.executable,
      cwd: command.cwd,
      env,
      outputFile: runtime.outputFile,
    })
  } catch (error) {
    return { ok: false, error: errorSummary(error) }
  }

  const pid = replacement.pid

  return await new Promise((resolve) => {
    let settled = false
    let spawnError: string | undefined
    const finish = (result: LoopRestartResult): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timeout)
      replacement.offError(onError)
      replacement.offExit(onExit)
      rmSync(readyFile, { force: true })
      if (result.ok) replacement.release()
      resolve(result)
    }
    const fail = (result: LoopRestartResult): void => {
      if (settled) return
      let terminationError: string | undefined
      let cleanupError: string | undefined
      try {
        os.terminateProcessTree(pid)
      } catch (error) {
        terminationError = errorSummary(error)
      }
      try {
        if (os.processTreeIsAlive(pid)) {
          cleanupError = terminationError ?? `Could not stop process tree ${pid}.`
        }
      } catch (error) {
        cleanupError = errorSummary(error)
      }
      finish(cleanupError === undefined ? result : {
        ...result,
        error: `${result.error ?? 'replacement startup failed'}; replacement cleanup failed: ${cleanupError}`,
      })
    }
    const onError = (error: Error): void => {
      spawnError = errorSummary(error)
      fail({ ok: false, pid, error: spawnError })
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const outcome = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      fail({
        ok: false,
        pid,
        error: spawnError ?? `replacement exited before becoming ready (${outcome})`,
      })
    }
    const poll = setInterval(() => {
      if (!existsSync(readyFile)) return
      let owner = ''
      try {
        owner = readFileSync(readyFile, 'utf8').trim()
      } catch {
        return
      }
      if (owner !== `${pid}`) {
        fail({
          ok: false,
          pid,
          error: `replacement published an unexpected PID (${owner || 'empty'})`,
        })
        return
      }
      if (!replacement.isAlive()) {
        fail({ ok: false, pid, error: 'replacement exited before becoming ready' })
        return
      }
      try {
        runtime.onReady?.(pid)
      } catch (error) {
        fail({ ok: false, pid, error: errorSummary(error) })
        return
      }
      finish({ ok: true, pid })
    }, 10)
    const timeout = setTimeout(() => {
      fail({
        ok: false,
        pid,
        error: 'replacement did not become ready before the startup timeout',
      })
    }, runtime.startupTimeoutMs ?? 30_000)
    replacement.onError(onError)
    replacement.onExit(onExit)
  })
}
