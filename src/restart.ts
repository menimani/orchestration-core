import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from './paths.ts'

export const LOOP_RESTART_READY_FILE_ENV = 'ORCHESTRATION_LOOP_RESTART_READY_FILE'

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
  packageRoot?: string
  spawn?: typeof spawn
  startupTimeoutMs?: number
  stdio?: StdioOptions
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
export function signalLoopRestartReady(env: NodeJS.ProcessEnv = process.env): void {
  const readyFile = env[LOOP_RESTART_READY_FILE_ENV]
  if (readyFile === undefined || readyFile === '') return
  writeFileSync(readyFile, `${process.pid}\n`, { flag: 'wx' })
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
  const spawnProcess = runtime.spawn ?? spawn
  let replacement: ChildProcess
  try {
    replacement = spawnProcess(command.executable, command.args, {
      cwd: command.cwd,
      env: {
        ...(runtime.env ?? process.env),
        [LOOP_RESTART_READY_FILE_ENV]: readyFile,
      },
      stdio: runtime.stdio ?? 'inherit',
      windowsHide: true,
    })
  } catch (error) {
    return { ok: false, error: errorSummary(error) }
  }

  const pid = replacement.pid
  if (pid === undefined) {
    replacement.kill()
    return { ok: false, error: 'replacement process did not receive a PID' }
  }

  return await new Promise((resolve) => {
    let settled = false
    let spawnError: string | undefined
    const finish = (result: LoopRestartResult): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timeout)
      replacement.off('error', onError)
      replacement.off('exit', onExit)
      rmSync(readyFile, { force: true })
      if (result.ok) replacement.unref()
      resolve(result)
    }
    const onError = (error: Error): void => {
      spawnError = errorSummary(error)
      finish({ ok: false, pid, error: spawnError })
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const outcome = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      finish({
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
        replacement.kill()
        finish({
          ok: false,
          pid,
          error: `replacement published an unexpected PID (${owner || 'empty'})`,
        })
        return
      }
      if (replacement.exitCode !== null) return
      finish({ ok: true, pid })
    }, 10)
    const timeout = setTimeout(() => {
      replacement.kill()
      finish({
        ok: false,
        pid,
        error: 'replacement did not become ready before the startup timeout',
      })
    }, runtime.startupTimeoutMs ?? 30_000)
    replacement.once('error', onError)
    replacement.once('exit', onExit)
  })
}
