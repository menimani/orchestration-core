import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Forge } from './adapters/forge.ts'
import { loadProject, type ProjectAdapter, type SuiteStep } from './adapters/project.ts'
import { QUEUE_LABELS } from './issueQueue.ts'
import { PACKAGE_ROOT, type OrchPaths } from './paths.ts'
import { execShellSync } from './shell.ts'

interface VerifyOptions {
  packageRoot?: string
  env?: NodeJS.ProcessEnv
  report?: (line: string) => void
  git?: (args: string[]) => string
  run?: (cwd: string, command: string) => boolean
}

function defaultGit(repoRoot: string): (args: string[]) => string {
  return (args) => execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function defaultRun(cwd: string, command: string): boolean {
  try {
    const output = execShellSync(command, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (output !== '') process.stdout.write(output)
    return true
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    if (failed.stdout !== undefined && failed.stdout !== '') process.stdout.write(failed.stdout)
    if (failed.stderr !== undefined && failed.stderr !== '') process.stderr.write(failed.stderr)
    return false
  }
}

function adapterPaths(project: ProjectAdapter): string[] {
  const paths: string[] = []
  const record = (step: {
    cwd: string
    requires?: string
  }): void => {
    if (step.cwd !== '') paths.push(step.cwd)
    if (step.requires !== undefined) paths.push(step.requires)
  }
  for (const step of project.preCommitChecks) record(step)
  for (const step of project.scanWorktreeSetup ?? []) record(step)
  for (const step of project.mergeChecks('full')) record(step)
  for (const step of project.mergeChecks('light')) record(step)
  for (const step of project.cycleSuite()) record(step)
  return [...new Set(paths)]
}

function safeRepositoryPath(repoRoot: string, referencedPath: string): string | undefined {
  if (isAbsolute(referencedPath)) return undefined
  const target = resolve(repoRoot, referencedPath)
  const outside = relative(repoRoot, target)
  return outside === '..' || outside.startsWith(`..${sep}`)
    ? undefined
    : target
}

function runSuiteStep(
  repoRoot: string,
  step: SuiteStep,
  run: (cwd: string, command: string) => boolean,
  report: (line: string) => void,
): 'pass' | 'fail' | 'skip' {
  if (step.requires !== undefined && !existsSync(join(repoRoot, step.requires))) {
    report(`SKIP: adapter suite step '${step.label}'; missing ${step.requires}`)
    return 'skip'
  }
  const repair = step.repairWhenMissing
  if (repair !== undefined && !existsSync(join(repoRoot, repair.path))) {
    if (!run(join(repoRoot, step.cwd), repair.command)) {
      report(`FAIL: adapter suite repair '${step.label}'; ${repair.message}`)
      return 'fail'
    }
  }
  const passed = run(join(repoRoot, step.cwd), step.command)
  report(`${passed ? 'PASS' : 'FAIL'}: adapter suite step '${step.label}'`)
  return passed ? 'pass' : 'fail'
}

export async function verifyRepositorySetup(
  paths: OrchPaths,
  forge: Forge,
  options: VerifyOptions = {},
): Promise<boolean> {
  const packageRoot = resolve(options.packageRoot ?? PACKAGE_ROOT)
  const report = options.report ?? console.log
  const git = options.git ?? defaultGit(paths.repoRoot)
  const run = options.run ?? defaultRun
  let ok = true

  const typecheckPassed = run(packageRoot, 'npm run typecheck')
  report(`${typecheckPassed ? 'PASS' : 'FAIL'}: orchestration TypeScript typecheck`)
  ok = typecheckPassed && ok

  let project: ProjectAdapter | undefined
  try {
    const env = options.env ?? process.env
    if (env['PROJECT_ADAPTER'] !== undefined && env['PROJECT_ADAPTER'] !== '') {
      project = await loadProject(paths.root, env)
      report(`PASS: loadProject selected adapter '${project.name}' with PROJECT_ADAPTER`)
    } else if (env['PROJECT'] !== undefined && env['PROJECT'] !== '') {
      project = await loadProject(paths.root, env)
      report(`PASS: loadProject selected adapter '${project.name}' with PROJECT`)
    } else {
      const discovered = await loadProject(paths.root, {})
      project = await loadProject(paths.root, { PROJECT: discovered.name })
      report(`PASS: loadProject discovered adapter '${project.name}' by name`)
    }
  } catch (error) {
    report(`FAIL: loadProject adapter discovery; ${(error as Error).message}`)
    ok = false
  }

  if (project === undefined) {
    report('SKIP: adapter suite; adapter could not be loaded')
    report('SKIP: adapter referenced paths; adapter could not be loaded')
  } else {
    const suite = project.cycleSuite()
    if (suite.length === 0) {
      report('SKIP: adapter suite; adapter declares no cycle-suite steps')
    } else {
      const results = suite.map((step) => runSuiteStep(paths.repoRoot, step, run, report))
      if (results.includes('fail')) {
        report('FAIL: adapter suite')
        ok = false
      } else if (results.includes('skip')) {
        report('SKIP: adapter suite; one or more declared steps were skipped')
      } else {
        report('PASS: adapter suite')
      }
    }

    const referenced = adapterPaths(project)
    const missing = referenced.filter((item) => {
      const target = safeRepositoryPath(paths.repoRoot, item)
      return target === undefined || !existsSync(target)
    })
    if (missing.length === 0) {
      report(`PASS: all ${referenced.length} adapter-referenced paths exist`)
    } else {
      report(`FAIL: adapter-referenced paths are missing or outside the repository: ${missing.join(', ')}`)
      ok = false
    }
  }

  try {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    if (upstream === '') throw new Error('upstream resolved to an empty name')
    git(['push', '--dry-run'])
    report(`PASS: current branch can push to ${upstream}`)
  } catch (error) {
    report(`FAIL: current branch has no pushable upstream; ${(error as Error).message.split(/\r?\n/, 1)[0]}`)
    ok = false
  }

  const expectedHooks = relative(paths.repoRoot, join(packageRoot, '.githooks')).replaceAll('\\', '/') || '.'
  try {
    const configuredHooks = git(['config', '--local', '--get', 'core.hooksPath'])
    if (configuredHooks !== expectedHooks) throw new Error(`${configuredHooks || '(unset)'} != ${expectedHooks}`)
    report(`PASS: core.hooksPath is ${expectedHooks}`)
  } catch (error) {
    report(`FAIL: core.hooksPath is not ${expectedHooks}; ${(error as Error).message.split(/\r?\n/, 1)[0]}`)
    ok = false
  }

  try {
    const labels = new Set(await forge.listLabels())
    const missing = QUEUE_LABELS.filter((label) => !labels.has(label.name)).map((label) => label.name)
    if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`)
    report(`PASS: all ${QUEUE_LABELS.length} loop labels exist`)
  } catch (error) {
    report(`FAIL: loop labels; ${(error as Error).message}`)
    ok = false
  }

  return ok
}
