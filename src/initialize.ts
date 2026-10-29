import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Forge } from './adapters/forge.ts'
import { renderProjectAdapter, repairProjectAdapterSource } from './adapters/project.ts'
import { ensureQueueLabels, QUEUE_LABELS } from './issueQueue.ts'
import { ensureScopeLabel, projectScopeLabel } from './issueScope.ts'
import { PACKAGE_ROOT, type OrchPaths } from './paths.ts'

export interface InitResult {
  ok: boolean
  projectName: string
  adapterPath: string
}

interface InitOptions {
  packageRoot?: string
  report?: (line: string) => void
  git?: (args: string[]) => string
  env?: NodeJS.ProcessEnv
}

const SCAFFOLD_FILES = [
  'README.md',
  'templates/scan-template.md',
  'templates/pitfalls/code.md',
  'templates/pitfalls/docs.md',
  'templates/pitfalls/tests.md',
] as const

function projectSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (slug === '') throw new Error(`Cannot derive a project name from '${value}'.`)
  return slug
}

function defaultGit(repoRoot: string): (args: string[]) => string {
  return (args) => execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function currentGitConfig(git: (args: string[]) => string, key: string): string {
  try {
    return git(['config', '--local', '--get', key])
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 1) return ''
    throw error
  }
}

function configuredValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  return value === undefined || value === '' ? undefined : value
}

function adapterFilenameName(adapterPath: string): string | undefined {
  return /^project-(.+)\.ts$/.exec(basename(adapterPath))?.[1]
}

function relativeImport(fromDirectory: string, target: string): string {
  const path = relative(fromDirectory, target).replaceAll('\\', '/')
  if (isAbsolute(path)) {
    throw new Error('The orchestration package and repository must be on the same filesystem volume.')
  }
  return path.startsWith('.') ? path : `./${path}`
}

export async function initializeRepository(
  paths: OrchPaths,
  forge: Forge,
  requestedName?: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const packageRoot = resolve(options.packageRoot ?? PACKAGE_ROOT)
  const report = options.report ?? console.log
  const git = options.git ?? defaultGit(paths.repoRoot)
  const env = options.env ?? process.env
  // The selection the adapter loader makes: PROJECT names the adapter and PROJECT_ADAPTER
  // overrides its path, so init creates or repairs the file the loop will load.
  const configuredName = configuredValue(env, 'PROJECT')
  const configuredPath = configuredValue(env, 'PROJECT_ADAPTER')
  const projectName = configuredName ?? projectSlug(requestedName ?? basename(paths.repoRoot))
  let ok = true
  if (configuredName !== undefined && requestedName !== undefined
    && projectSlug(requestedName) !== configuredName) {
    report(`DIVERGED: project name '${projectSlug(requestedName)}' disagrees with PROJECT=${configuredName}; using PROJECT`)
    ok = false
  }

  const projectDirectory = join(paths.projectRoot, 'project')
  const configuredAdapterPath = configuredPath !== undefined
    ? resolve(paths.projectRoot, configuredPath)
    : configuredName === undefined ? undefined : join(projectDirectory, `project-${configuredName}.ts`)
  const typeImport = relativeImport(
    configuredAdapterPath === undefined ? projectDirectory : dirname(configuredAdapterPath),
    join(packageRoot, 'src', 'adapters', 'project.ts'),
  )
  // A fleet project's repository knows nothing of the orchestration, so its hooks stay
  // its own and nothing here is configured in it.
  const hooksPath = paths.fleet === undefined ? coreHooksPath(paths, packageRoot) : undefined

  mkdirSync(paths.projectRoot, { recursive: true })
  mkdirSync(projectDirectory, { recursive: true })
  let adapterPath = join(projectDirectory, `project-${projectName}.ts`)
  if (configuredAdapterPath !== undefined) {
    adapterPath = configuredAdapterPath
    const adapterName = configuredName ?? adapterFilenameName(adapterPath) ?? projectName
    if (existsSync(adapterPath)) {
      ok = repairAdapter(adapterPath, adapterName, report) && ok
    } else {
      mkdirSync(dirname(adapterPath), { recursive: true })
      writeFileSync(adapterPath, renderProjectAdapter(adapterName, typeImport))
      report(`CREATED: ${adapterPath}`)
    }
  } else {
    const existingAdapters = readdirSync(projectDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^project-.+\.ts$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    if (existingAdapters.length === 0) {
      writeFileSync(adapterPath, renderProjectAdapter(projectName, typeImport))
      report(`CREATED: ${adapterPath}`)
    } else {
      adapterPath = join(projectDirectory, existingAdapters[0]!)
      if (existingAdapters.length > 1) {
        report(`EXISTS: ${existingAdapters.map((name) => join(projectDirectory, name)).join(', ')} (left unchanged)`)
        report(`DIVERGED: found ${existingAdapters.length} project adapters; automatic discovery requires one; set PROJECT=<name> or PROJECT_ADAPTER to select it`)
        ok = false
      } else {
        ok = repairAdapter(adapterPath, adapterFilenameName(adapterPath)!, report) && ok
      }
    }
  }

  const scaffoldRoot = join(packageRoot, 'scaffold')
  for (const relativePath of SCAFFOLD_FILES) {
    const source = join(scaffoldRoot, relativePath)
    const destination = join(paths.projectRoot, relativePath)
    if (existsSync(destination)) {
      report(`EXISTS: ${destination} (left unchanged)`)
      continue
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, readFileSync(source))
    report(`CREATED: ${destination}`)
  }

  if (hooksPath === undefined) {
    report('SKIP: core.hooksPath; a fleet project leaves its repository\'s hooks unchanged')
  } else if (!configureCoreHooks(git, hooksPath, report)) {
    ok = false
  }

  if (paths.fleet !== undefined && paths.fleet.issueRepository === undefined) {
    report('SKIP: loop labels; a fleet project without an issue repository files no issues')
  } else {
    const createdLabels = new Set(await ensureQueueLabels(forge))
    for (const label of QUEUE_LABELS) {
      report(`${createdLabels.has(label.name) ? 'CREATED' : 'EXISTS'}: label ${label.name}`)
    }
    if (paths.fleet !== undefined) {
      const scope = projectScopeLabel(paths.fleet.project)
      report(`${await ensureScopeLabel(forge, scope) ? 'CREATED' : 'EXISTS'}: label ${scope}`)
    }
  }

  return { ok, projectName, adapterPath }
}

function repairAdapter(
  adapterPath: string,
  adapterName: string,
  report: (line: string) => void,
): boolean {
  const source = readFileSync(adapterPath, 'utf8')
  const repair = repairProjectAdapterSource(source, adapterName)
  if (repair.problem !== undefined) {
    report(`DIVERGED: ${adapterPath}; ${repair.problem} (left unchanged)`)
    return false
  }
  if (repair.addedMembers.length === 0) {
    report(`EXISTS: ${adapterPath} (contract complete; left unchanged)`)
    return true
  }
  writeFileSync(adapterPath, repair.source)
  for (const member of repair.addedMembers) {
    report(`REPAIRED: ${adapterPath}; added required member '${member}'`)
  }
  return true
}

function coreHooksPath(paths: OrchPaths, packageRoot: string): string {
  const hooksDirectory = join(packageRoot, '.githooks')
  const hooksPath = relative(paths.repoRoot, hooksDirectory).replaceAll('\\', '/') || '.'
  if (isAbsolute(hooksPath)) {
    throw new Error('The orchestration package and repository must be on the same filesystem volume.')
  }
  if (hooksPath === '..' || hooksPath.startsWith('../')) {
    throw new Error('The orchestration package must be inside the repository before init runs.')
  }
  if (!existsSync(join(hooksDirectory, 'commit-msg'))
    || !existsSync(join(hooksDirectory, 'pre-commit'))) {
    throw new Error(`Core-owned hooks are missing from ${hooksDirectory}.`)
  }
  return hooksPath
}

function configureCoreHooks(
  git: (args: string[]) => string,
  hooksPath: string,
  report: (line: string) => void,
): boolean {
  let ok = true
  const configuredHooksPath = currentGitConfig(git, 'core.hooksPath')
  if (configuredHooksPath === '') {
    git(['config', '--local', 'core.hooksPath', hooksPath])
    report(`CONFIGURED: core.hooksPath=${hooksPath}`)
  } else if (configuredHooksPath === hooksPath) {
    report(`EXISTS: core.hooksPath=${hooksPath}`)
  } else {
    report(`DIVERGED: core.hooksPath=${configuredHooksPath} (expected ${hooksPath}; left unchanged)`)
    ok = false
  }
  const verifiedHooksPath = currentGitConfig(git, 'core.hooksPath')
  if (verifiedHooksPath === hooksPath) {
    report(`PASS: core.hooksPath is ${hooksPath}`)
  } else {
    report(`FAIL: core.hooksPath is ${verifiedHooksPath || '(unset)'}; expected ${hooksPath}`)
    ok = false
  }
  return ok
}
