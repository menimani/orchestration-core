import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageCommandPrefix, packagePathPrefix } from '../paths.ts'
import { operatingSystem } from './os.ts'
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
  const commandPrefix = options.commandPrefix
    ?? packageCommandPrefix(options.repoRoot, options.packageRoot)
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
      options.packagePathPrefix ?? packagePathPrefix(options.repoRoot, options.packageRoot),
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
      userDestinationRoot: (home) => join(home, '.agents', 'skills'),
      renderFile: renderSharedSkillFile,
    },
    resolveModel,
    start(options: RunnerStartOptions): Promise<number> {
      return operatingSystem.launchAgent({
        args: buildArgs(options),
        cwd: options.worktree,
        inputFile: options.specFile,
        outputFile: options.logFile,
        program: 'codex',
      })
    },
  }
}
