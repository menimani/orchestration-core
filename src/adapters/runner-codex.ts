import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageCommandPrefix, packagePathPrefix } from '../paths.ts'
import { startWindowsProcess } from './windows-process.ts'
import type {
  Runner, RunnerModelOptions, RunnerSharedSkillRenderOptions, RunnerStartOptions,
} from './runner.ts'

// The spec is the prompt, read by Codex from standard input via `-`; the final
// message lands in --output-last-message, which is the only place the core reads
// completion markers from. Effort maps to the codex-specific
// `model_reasoning_effort` config key here, not in the core.
//
// A worker never delegates to another agent, so `multi_agent` only adds its primary-agent
// framing to the request. Codex enables it by default, and every request carries the whole
// transcript, so the framing is paid once per turn rather than once per task.
function buildArgs(options: RunnerStartOptions): string[] {
  const args = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--disable', 'multi_agent',
    '--output-last-message', options.finalMessageFile,
  ]
  const model = resolveModel(options)
  if (model !== undefined) args.push('--model', model)
  args.push('--config', `model_reasoning_effort=${options.effort}`)
  args.push('-')
  return args
}

function resolveModel(options: RunnerModelOptions): string | undefined {
  return options.model === undefined || options.model === '' ? undefined : options.model
}

function renderSharedSkillFile(
  contents: Buffer,
  options: RunnerSharedSkillRenderOptions,
): Buffer {
  const commandPrefix = packageCommandPrefix(options.repoRoot, options.packageRoot)
  let text = contents.toString('utf8')
  const argumentHint = /^argument-hint:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1]
    ?? '<arguments from the request>'
  let declaredSharedSkills: string[] = []
  try {
    const manifest = JSON.parse(
      readFileSync(join(options.packageRoot, 'skills', 'manifest.json'), 'utf8'),
    ) as { skills?: unknown }
    if (Array.isArray(manifest.skills)) {
      declaredSharedSkills = manifest.skills.filter((skill): skill is string =>
        typeof skill === 'string')
    }
  } catch {
    // A missing or invalid manifest means no package skill can be assumed installed.
  }
  const skillAvailable = (skill: string): boolean =>
    existsSync(join(options.repoRoot, '.agents', 'skills', skill, 'SKILL.md'))
      || (declaredSharedSkills.includes(skill)
        && existsSync(join(options.packageRoot, 'skills', skill, 'SKILL.md')))
  const guidanceFile = existsSync(join(options.repoRoot, 'CLAUDE.md'))
    || !existsSync(join(options.repoRoot, 'AGENTS.md'))
    ? 'CLAUDE.md'
    : 'AGENTS.md'
  text = text
    .replaceAll(options.commandPrefixPlaceholder, commandPrefix)
    .replaceAll(
      options.packagePathPrefixPlaceholder,
      packagePathPrefix(options.repoRoot, options.packageRoot),
    )
    .replaceAll('CLAUDE.md', guidanceFile)
    .replace(
      /\.claude\/skills\/([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(\/SKILL\.md)?/g,
      (reference, skill: string, suffix = '') => {
        if (existsSync(join(options.repoRoot, ...reference.split('/')))) return reference
        return skillAvailable(skill) ? `.agents/skills/${skill}${suffix}` : reference
      },
    )
    .replaceAll('$ARGUMENTS', argumentHint)
    .replace(/^(?:argument-hint|allowed-tools|disable-model-invocation):[^\r\n]*(?:\r?\n)/gm, '')
    .replace(
      /^([ \t]*)!`([^`\r\n]+)`[ \t]*$/gm,
      (_line, indentation: string, command: string) =>
        `${indentation}Run \`${command}\` and use its output as context before continuing.`,
    )
    .replace(
      /(^|[\s(—])(`?)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\2(?=$|[\s.,;:)—])/gm,
      (_invocation, prefix: string, quote: string, skill: string) => {
        if (skillAvailable(skill)) return `${prefix}${quote}$${skill}${quote}`
        const directInstruction = skill === 'verify-changes'
          ? 'verification directly with the applicable repository commands'
          : skill === 'git-review'
            ? 'a direct review of the changes'
            : `the ${skill} workflow directly`
        return `${prefix}${directInstruction}`
      },
    )
  return Buffer.from(text)
}

export function createCodexRunner(): Runner {
  return {
    sharedSkills: {
      // `.claude/skills` was this runner's former discovery path, but it is not a legacy
      // root: a consumer may still select that interactive-agent target independently.
      // Claiming it here would empty it whenever Codex was the selected runner.
      destinationRoot: (repoRoot) => join(repoRoot, '.agents', 'skills'),
      renderFile: renderSharedSkillFile,
    },
    resolveModel,
    start(options: RunnerStartOptions): Promise<number> {
      const args = buildArgs(options)
      // On Windows the `codex` on PATH is an npm .cmd shim, which Node cannot spawn
      // without a shell. Git Bash is already a hard requirement of this repository,
      // so route through `bash -c` with positional arguments.
      const viaBash = process.platform === 'win32'
      const command = viaBash ? 'bash' : 'codex'
      const commandArgs = viaBash
        ? ['-c', 'exec codex "$@"', 'codex', ...args]
        : args

      if (viaBash) {
        // Measured on Windows: detached launches gave every console descendant its own
        // visible window. The hidden launcher gives the task one non-visible console,
        // inherited by all of its tools, while still surviving the daemon that starts it.
        return startWindowsProcess({
          args: commandArgs,
          command,
          cwd: options.worktree,
          inputFile: options.specFile,
          outputFile: options.logFile,
        })
      }

      // startTask clears this file before setup; append so setup output remains ahead
      // of the runner transcript instead of being silently truncated here.
      const logFd = openSync(options.logFile, 'a')
      let specFd: number
      try {
        specFd = openSync(options.specFile, 'r')
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
          child = spawn(command, commandArgs, {
            cwd: options.worktree,
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
            reject(new Error('codex spawned without a PID'))
            return
          }
          resolve(child.pid)
        })
      })
    },
  }
}
