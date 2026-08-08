import { spawn } from 'node:child_process'
import { openSync, readFileSync } from 'node:fs'
import type { Runner, RunnerStartOptions } from './runner.ts'

// Ported from bin/task-start.sh: the spec content is the prompt, passed as one
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
      const logFd = openSync(options.logFile, 'w')

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
        const child = spawn(command, commandArgs, {
          cwd: options.worktree,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          windowsHide: true,
        })
        child.once('error', reject)
        child.once('spawn', () => {
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
