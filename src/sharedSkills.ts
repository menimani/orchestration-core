import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { packageCommandPrefix } from './paths.ts'

const STATE_FILE = '.orchestration-core-sync.json'

interface SharedSkillsManifest {
  commandPrefixPlaceholder: string
  skills: string[]
}

interface SharedSkillsState {
  version: 1
  skills: Record<string, string>
}

interface RenderedFile {
  path: string
  contents: Buffer
}

export interface SharedSkillsSyncResult {
  installed: string[]
  updated: string[]
  conflicts: string[]
  changedPaths: string[]
  managedPaths: string[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readManifest(packageRoot: string): SharedSkillsManifest {
  const file = join(packageRoot, 'skills', 'manifest.json')
  const parsed = object(JSON.parse(readFileSync(file, 'utf8')))
  const placeholder = parsed?.commandPrefixPlaceholder
  const skills = parsed?.skills
  if (typeof placeholder !== 'string' || placeholder === '' || !Array.isArray(skills)
    || skills.some((skill) => typeof skill !== 'string'
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(skill))) {
    throw new Error(`invalid shared skills manifest: ${file}`)
  }
  if (new Set(skills).size !== skills.length) {
    throw new Error(`duplicate skill in shared skills manifest: ${file}`)
  }
  return { commandPrefixPlaceholder: placeholder, skills: skills as string[] }
}

function readState(file: string): SharedSkillsState {
  if (!existsSync(file)) return { version: 1, skills: {} }
  const parsed = object(JSON.parse(readFileSync(file, 'utf8')))
  const skills = object(parsed?.skills)
  if (parsed?.version !== 1 || skills === undefined
    || Object.values(skills).some((hash) => typeof hash !== 'string'
      || !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error(`invalid shared skills sync state: ${file}`)
  }
  return { version: 1, skills: skills as Record<string, string> }
}

function filesIn(root: string, current = root): RenderedFile[] {
  const files: RenderedFile[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`shared skills cannot contain symlinks: ${path}`)
    if (entry.isDirectory()) files.push(...filesIn(root, path))
    else if (entry.isFile()) files.push({
      path: relative(root, path).replaceAll('\\', '/'),
      contents: readFileSync(path),
    })
    else throw new Error(`unsupported shared skill entry: ${path}`)
  }
  return files
}

function renderedSkill(
  packageRoot: string,
  skill: string,
  placeholder: string,
  commandPrefix: string,
): RenderedFile[] {
  const source = join(packageRoot, 'skills', skill)
  if (!existsSync(join(source, 'SKILL.md'))) {
    throw new Error(`shared skill has no SKILL.md: ${source}`)
  }
  return filesIn(source).map((file) => ({
    ...file,
    contents: Buffer.from(file.contents.toString('utf8').replaceAll(placeholder, commandPrefix)),
  }))
}

function hashFiles(files: readonly RenderedFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.contents)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function extendedLengthPath(path: string): string {
  const absolute = resolve(path)
  if (absolute.startsWith('\\\\?\\')) return absolute
  if (absolute.startsWith('\\\\')) return `\\\\?\\UNC\\${absolute.slice(2)}`
  return `\\\\?\\${absolute}`
}

function removeDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    if (process.platform !== 'win32') throw error
    rmSync(extendedLengthPath(path), { recursive: true, force: true })
  }
}

function replaceDirectory(destination: string, files: readonly RenderedFile[]): void {
  const parent = dirname(destination)
  const nonce = `${process.pid}-${randomUUID()}`
  const temporary = join(parent, `.${destination.split(/[\\/]/).at(-1)}.sync-${nonce}`)
  const backup = `${temporary}.old`
  mkdirSync(temporary, { recursive: true })
  try {
    for (const file of files) {
      const target = join(temporary, ...file.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.contents)
    }
    if (existsSync(destination)) renameSync(destination, backup)
    try {
      renameSync(temporary, destination)
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, destination)
      throw error
    }
    try {
      removeDirectory(backup)
    } catch (error) {
      removeDirectory(destination)
      renameSync(backup, destination)
      throw error
    }
  } finally {
    removeDirectory(temporary)
  }
}

function writeState(file: string, state: SharedSkillsState): void {
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  try {
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Materialize the package's declared shared skills at the repository root. The state
 * records the exact rendered tree last written, so later syncs never mistake a person's
 * edit (including an added support file or a deletion) for an old generated copy.
 */
export function syncSharedSkills(repoRoot: string, packageRoot: string): SharedSkillsSyncResult {
  const manifest = readManifest(packageRoot)
  const destinationRoot = join(repoRoot, '.claude', 'skills')
  const stateFile = join(destinationRoot, STATE_FILE)
  mkdirSync(destinationRoot, { recursive: true })
  const state = readState(stateFile)
  const nextState: SharedSkillsState = { version: 1, skills: { ...state.skills } }
  const installed: string[] = []
  const updated: string[] = []
  const conflicts: string[] = []
  const changedPaths: string[] = []
  const managedPaths: string[] = []
  const commandPrefix = packageCommandPrefix(repoRoot, packageRoot)

  for (const skill of manifest.skills) {
    const destination = join(destinationRoot, skill)
    const desiredFiles = renderedSkill(
      packageRoot, skill, manifest.commandPrefixPlaceholder, commandPrefix,
    )
    const desiredHash = hashFiles(desiredFiles)
    const previousHash = state.skills[skill]
    if (existsSync(destination)) {
      if (!lstatSync(destination).isDirectory()) {
        conflicts.push(skill)
        continue
      }
      const currentHash = hashFiles(filesIn(destination))
      if (currentHash === desiredHash) {
        if (previousHash === desiredHash) managedPaths.push(destination)
        continue
      }
      if (previousHash === undefined || currentHash !== previousHash) {
        conflicts.push(skill)
        continue
      }
      replaceDirectory(destination, desiredFiles)
      nextState.skills[skill] = desiredHash
      updated.push(skill)
      changedPaths.push(destination)
      managedPaths.push(destination)
      continue
    }
    if (previousHash !== undefined) {
      conflicts.push(skill)
      continue
    }
    replaceDirectory(destination, desiredFiles)
    nextState.skills[skill] = desiredHash
    installed.push(skill)
    changedPaths.push(destination)
    managedPaths.push(destination)
  }

  if (installed.length > 0 || updated.length > 0) {
    writeState(stateFile, nextState)
    changedPaths.push(stateFile)
  }
  if (Object.keys(nextState.skills).length > 0) managedPaths.push(stateFile)
  return { installed, updated, conflicts, changedPaths, managedPaths }
}
