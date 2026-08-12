import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { Forge } from './adapters/forge.ts'
import { renderProjectAdapter, repairProjectAdapterSource } from './adapters/project.ts'
import { ensureQueueLabels, QUEUE_LABELS } from './issueQueue.ts'
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

function relativeImport(fromDirectory: string, target: string): string {
  const path = relative(fromDirectory, target).replaceAll('\\', '/')
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
  const projectName = projectSlug(requestedName ?? basename(paths.repoRoot))
  let ok = true

  mkdirSync(paths.root, { recursive: true })
  const projectDirectory = join(paths.root, 'project')
  mkdirSync(projectDirectory, { recursive: true })
  const existingAdapters = readdirSync(projectDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^project-.+\.ts$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  let adapterPath = join(projectDirectory, `project-${projectName}.ts`)
  if (existingAdapters.length === 0) {
    const typeImport = relativeImport(
      projectDirectory,
      join(packageRoot, 'src', 'adapters', 'project.ts'),
    )
    writeFileSync(adapterPath, renderProjectAdapter(projectName, typeImport))
    report(`CREATED: ${adapterPath}`)
  } else {
    adapterPath = join(projectDirectory, existingAdapters[0]!)
    if (existingAdapters.length > 1) {
      report(`EXISTS: ${existingAdapters.map((name) => join(projectDirectory, name)).join(', ')} (left unchanged)`)
      report(`DIVERGED: found ${existingAdapters.length} project adapters; automatic discovery requires one`)
      ok = false
    } else {
      const adapterName = basename(existingAdapters[0]!, '.ts').slice('project-'.length)
      const source = readFileSync(adapterPath, 'utf8')
      const repair = repairProjectAdapterSource(source, adapterName)
      if (repair.problem !== undefined) {
        report(`DIVERGED: ${adapterPath}; ${repair.problem} (left unchanged)`)
        ok = false
      } else if (repair.addedMembers.length === 0) {
        report(`EXISTS: ${adapterPath} (contract complete; left unchanged)`)
      } else {
        writeFileSync(adapterPath, repair.source)
        for (const member of repair.addedMembers) {
          report(`REPAIRED: ${adapterPath}; added required member '${member}'`)
        }
      }
    }
  }

  const scaffoldRoot = join(packageRoot, 'scaffold')
  for (const relativePath of SCAFFOLD_FILES) {
    const source = join(scaffoldRoot, relativePath)
    const destination = join(paths.root, relativePath)
    if (existsSync(destination)) {
      report(`EXISTS: ${destination} (left unchanged)`)
      continue
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, readFileSync(source))
    report(`CREATED: ${destination}`)
  }

  const hooksDirectory = join(packageRoot, '.githooks')
  if (!existsSync(join(hooksDirectory, 'commit-msg'))
    || !existsSync(join(hooksDirectory, 'pre-commit'))) {
    throw new Error(`Core-owned hooks are missing from ${hooksDirectory}.`)
  }
  const hooksPath = relative(paths.repoRoot, hooksDirectory).replaceAll('\\', '/') || '.'
  if (hooksPath === '..' || hooksPath.startsWith('../')) {
    throw new Error('The orchestration package must be inside the repository before init runs.')
  }
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

  const createdLabels = new Set(await ensureQueueLabels(forge))
  for (const label of QUEUE_LABELS) {
    report(`${createdLabels.has(label.name) ? 'CREATED' : 'EXISTS'}: label ${label.name}`)
  }

  return { ok, projectName, adapterPath }
}
