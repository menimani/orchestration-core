import { spawn } from 'node:child_process'
import {
  closeSync, openSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageCommandPrefix } from '../paths.ts'
import { startWindowsProcess } from './windows-process.ts'
import type {
  ReasoningEffort, Runner, RunnerLoadOptions, RunnerSharedSkillRenderOptions,
  RunnerStartOptions,
} from './runner.ts'

const DEFAULT_MODEL = 'claude-opus-5'
const WRAPPER_ARGUMENT = '--claude-runner-wrapper'

function configuredModel(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value
}

function effortModels(options: RunnerLoadOptions): Record<ReasoningEffort, string> {
  const base = configuredModel(options.runnerClaudeModel, DEFAULT_MODEL)
  return {
    minimal: configuredModel(options.runnerClaudeModelMinimal, base),
    low: configuredModel(options.runnerClaudeModelLow, base),
    medium: configuredModel(options.runnerClaudeModelMedium, base),
    high: configuredModel(options.runnerClaudeModelHigh, base),
  }
}

// Claude print mode reads the task specification from standard input. It has no
// output-last-message option, so the detached wrapper below tees stdout to the transcript
// and publishes it atomically as the final-message file only after Claude exits.
function buildArgs(
  options: RunnerStartOptions,
  models: Record<ReasoningEffort, string>,
): string[] {
  const model = configuredModel(options.model, models[options.effort])
  return ['-p', '--permission-mode', 'bypassPermissions', '--model', model]
}

function renderSharedSkillFile(
  contents: Buffer,
  options: RunnerSharedSkillRenderOptions,
): Buffer {
  return Buffer.from(contents.toString('utf8').replaceAll(
    options.commandPrefixPlaceholder,
    packageCommandPrefix(options.repoRoot, options.packageRoot),
  ))
}

function publishFinalMessage(file: string, contents: Buffer): void {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, contents)
  try {
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Run Claude as the durable wrapper's child and return its exit code. */
export function runClaudeProcess(
  finalMessageFile: string,
  args: readonly string[],
): Promise<number> {
  const viaBash = process.platform === 'win32'
  const command = viaBash ? 'bash' : 'claude'
  const commandArgs = viaBash
    ? ['-c', 'exec claude "$@"', 'claude', ...args]
    : [...args]

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, commandArgs, {
        detached: false,
        stdio: ['inherit', 'pipe', 'inherit'],
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }
    const output: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      output.push(buffer)
      process.stdout.write(buffer)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      try {
        publishFinalMessage(finalMessageFile, Buffer.concat(output))
        resolve(code ?? 1)
      } catch (error) {
        reject(error)
      }
    })
  })
}

export function createClaudeRunner(options: RunnerLoadOptions = {}): Runner {
  const models = effortModels(options)
  return {
    sharedSkills: {
      destinationRoot: (repoRoot) => join(repoRoot, '.claude', 'skills'),
      renderFile: renderSharedSkillFile,
    },
    start(startOptions: RunnerStartOptions): Promise<number> {
      const wrapperArgs = [
        fileURLToPath(import.meta.url),
        WRAPPER_ARGUMENT,
        startOptions.finalMessageFile,
        ...buildArgs(startOptions, models),
      ]

      if (process.platform === 'win32') {
        return startWindowsProcess({
          args: wrapperArgs,
          command: process.execPath,
          cwd: startOptions.worktree,
          inputFile: startOptions.specFile,
          outputFile: startOptions.logFile,
        })
      }

      const logFd = openSync(startOptions.logFile, 'a')
      let specFd: number
      try {
        specFd = openSync(startOptions.specFile, 'r')
      } catch (error) {
        closeSync(logFd)
        return Promise.reject(error)
      }

      return new Promise((resolve, reject) => {
        let descriptorsClosed = false
        const closeDescriptors = (): void => {
          if (descriptorsClosed) return
          descriptorsClosed = true
          try {
            closeSync(specFd)
          } finally {
            closeSync(logFd)
          }
        }

        let child
        try {
          child = spawn(process.execPath, wrapperArgs, {
            cwd: startOptions.worktree,
            detached: true,
            stdio: [specFd, logFd, logFd],
            windowsHide: true,
          })
        } catch (error) {
          closeDescriptors()
          reject(error)
          return
        }
        child.once('error', (error) => {
          closeDescriptors()
          reject(error)
        })
        child.once('spawn', () => {
          closeDescriptors()
          child.unref()
          if (child.pid === undefined) {
            reject(new Error('claude runner spawned without a PID'))
            return
          }
          resolve(child.pid)
        })
      })
    },
  }
}

if (process.argv[2] === WRAPPER_ARGUMENT) {
  const finalMessageFile = process.argv[3]
  if (finalMessageFile === undefined) {
    process.stderr.write('Claude runner wrapper requires a final-message file.\n')
    process.exitCode = 1
  } else {
    try {
      process.exitCode = await runClaudeProcess(finalMessageFile, process.argv.slice(4))
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error)
      process.stderr.write(`Claude runner failed: ${detail}\n`)
      process.exitCode = 1
    }
  }
}
