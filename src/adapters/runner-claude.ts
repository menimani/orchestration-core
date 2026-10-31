import { spawn } from 'node:child_process'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClaudeSharedSkills } from './shared-skills-claude.ts'
import { operatingSystem } from './os.ts'
import type {
  ReasoningEffort, Runner, RunnerLoadOptions, RunnerModelOptions, RunnerStartOptions,
} from './runner.ts'

const DEFAULT_MODEL = 'claude-opus-5'
const WRAPPER_ARGUMENT = '--claude-runner-wrapper'

function configuredModel(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value
}

function effortModels(options: RunnerLoadOptions): Record<ReasoningEffort, string> {
  const base = configuredModel(options.env.RUNNER_CLAUDE_MODEL, DEFAULT_MODEL)
  return {
    minimal: configuredModel(options.env.RUNNER_CLAUDE_MODEL_MINIMAL, base),
    low: configuredModel(options.env.RUNNER_CLAUDE_MODEL_LOW, base),
    medium: configuredModel(options.env.RUNNER_CLAUDE_MODEL_MEDIUM, base),
    high: configuredModel(options.env.RUNNER_CLAUDE_MODEL_HIGH, base),
  }
}

// Claude print mode reads the task specification from standard input. It has no
// output-last-message option, so the detached wrapper below tees stdout to the transcript
// and publishes it atomically as the final-message file only after Claude exits.
function buildArgs(model: string): string[] {
  return ['-p', '--permission-mode', 'bypassPermissions', '--model', model]
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
  return new Promise((resolve, reject) => {
    let child
    try {
      // Claude may be a native executable or an npm .cmd shim; the operating-system
      // adapter decides how either is spawned.
      const { command, args: commandArgs, verbatimArguments } = operatingSystem.agentCommand(
        'claude', args,
      )
      child = spawn(command, commandArgs, {
        ...(verbatimArguments ? { windowsVerbatimArguments: true } : {}),
        detached: false,
        // `claude -p` exits when its turn ends, killing anything it left running in
        // the background. Tasks that started the suite that way ended with "I'll commit
        // once it finishes" and lost their work, so the agent may only run in the
        // foreground.
        env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
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

export function createClaudeRunner(
  options: RunnerLoadOptions = { env: process.env },
): Runner {
  const models = effortModels(options)
  const resolveModel = (modelOptions: RunnerModelOptions): string =>
    configuredModel(modelOptions.model, models[modelOptions.effort])
  return {
    sharedSkills: createClaudeSharedSkills(),
    resolveModel,
    start(startOptions: RunnerStartOptions): Promise<number> {
      const wrapperArgs = [
        fileURLToPath(import.meta.url),
        WRAPPER_ARGUMENT,
        startOptions.finalMessageFile,
        ...buildArgs(resolveModel(startOptions)),
      ]
      return operatingSystem.launchAgent({
        args: wrapperArgs,
        cwd: startOptions.worktree,
        inputFile: startOptions.specFile,
        outputFile: startOptions.logFile,
        program: process.execPath,
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
