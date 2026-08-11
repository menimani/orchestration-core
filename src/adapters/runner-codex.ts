import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import type { Runner, RunnerStartOptions } from './runner.ts'

// The spec content is the prompt, passed as one
// argument; the final message lands in --output-last-message, which is the only
// place the core reads completion markers from. Effort maps to the codex-specific
// `model_reasoning_effort` config key here, not in the core.
function buildArgs(options: RunnerStartOptions, specContent: string): string[] {
  const args = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--output-last-message', options.finalMessageFile,
  ]
  if (options.model !== undefined && options.model !== '') {
    args.push('--model', options.model)
  }
  args.push('--config', `model_reasoning_effort=${options.effort}`)
  args.push(specContent)
  return args
}

export function createCodexRunner(): Runner {
  return {
    start(options: RunnerStartOptions): Promise<number> {
      const specContent = readFileSync(options.specFile, 'utf8')
      const args = buildArgs(options, specContent)
      // startTask clears this file before setup; append so setup output remains ahead
      // of the runner transcript instead of being silently truncated here.
      const logFd = openSync(options.logFile, 'a')

      // On Windows the `codex` on PATH is an npm .cmd shim, which Node cannot spawn
      // without a shell — and shell quoting would mangle the multi-line spec argument.
      // Git Bash is already a hard requirement of this repository, so route through
      // `bash -c` with positional arguments: nothing is ever re-quoted.
      const viaBash = process.platform === 'win32'
      const command = viaBash ? 'bash' : 'codex'
      const commandArgs = viaBash
        ? ['-c', 'exec codex "$@"', 'codex', ...args]
        : args

      return new Promise((resolve, reject) => {
        let logFdClosed = false
        const closeLogFd = (): void => {
          if (logFdClosed) return
          closeSync(logFd)
          logFdClosed = true
        }

        let child
        try {
          child = spawn(command, commandArgs, {
            cwd: options.worktree,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            windowsHide: true,
          })
        } catch (error) {
          closeLogFd()
          reject(error)
          return
        }
        child.once('error', (error) => {
          closeLogFd()
          reject(error)
        })
        child.once('spawn', () => {
          closeLogFd()
          child.unref()
          if (child.pid === undefined) {
            reject(new Error('codex spawned without a PID'))
            return
          }
          resolve(child.pid)
        })
      })
    },
  }
}
