import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { operatingSystem, type OperatingSystem } from './adapters/os.ts'
import type { SharedSkillRenderOptions, SharedSkillsAdapter } from './adapters/shared-skills.ts'
import { fleetCommandPrefix, shellPathSpelling } from './paths.ts'

const STATE_FILE = '.orchestration-core-sync.json'

/**
 * One directory a repository-scoped skill is discovered in, with the rendering that
 * directory's reader expects. The loop's runner is only one such reader: a person drives
 * an interactive agent in the same repository, and it discovers its own directory. When
 * only the runner was served, selecting Codex removed every shared workflow from the
 * interactive agent — including the merge workflow this repository routes merges through.
 */
interface SharedSkillTarget {
  destinationRoot: string
  legacyRoots: readonly string[]
  renderFile(contents: Buffer, options: SharedSkillRenderOptions): Buffer
}

interface SharedSkillsManifest {
  commandPrefixPlaceholder: string
  packagePathPrefixPlaceholder: string
  projectGuidancePlaceholder: string
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

/**
 * Project-owned guidance appended at the shared skill's named injection point. The root is
 * the project's asset directory, never derived from the destination: a user install
 * serves every project of a fleet and so carries no project's guidance.
 */
function projectGuidanceFileForSkill(guidanceRoot: string, skill: string): string {
  return join(guidanceRoot, 'project', 'skills', `${skill}.md`)
}

export interface SharedSkillsSyncResult {
  installed: string[]
  updated: string[]
  conflicts: string[]
  migrationConflicts: string[]
  removedPaths: string[]
  changedPaths: string[]
  managedPaths: string[]
  /** One message per target that could not be served at all. */
  failures: string[]
}

export interface SharedSkillManagedTarget {
  destinationRoot: string
  managedPaths: string[]
}

/** Managed paths grouped by the destination that must be synced as one unit. */
export function sharedSkillManagedTargets(
  repoRoot: string,
  packageRoot: string,
  adapters: readonly SharedSkillsAdapter[],
): SharedSkillManagedTarget[] {
  readManifest(packageRoot)
  return skillTargets(repoRoot, adapters).map((target) => {
    const stateFile = join(target.destinationRoot, STATE_FILE)
    const state = readState(stateFile)
    const paths = [stateFile]
    paths.push(...Object.keys(state.skills).map((skill) => join(target.destinationRoot, skill)))
    for (const legacyRoot of target.legacyRoots) {
      const stateFile = join(legacyRoot, STATE_FILE)
      if (!existsSync(stateFile)) continue
      const state = readState(stateFile)
      paths.push(stateFile)
      paths.push(...Object.keys(state.skills).map((skill) => join(legacyRoot, skill)))
    }
    return { destinationRoot: target.destinationRoot, managedPaths: [...new Set(paths)] }
  })
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
  const packagePathPrefixPlaceholder = parsed?.packagePathPrefixPlaceholder
  const projectGuidancePlaceholder = parsed?.projectGuidancePlaceholder
  const skills = parsed?.skills
  if (typeof placeholder !== 'string' || placeholder === ''
    || typeof packagePathPrefixPlaceholder !== 'string' || packagePathPrefixPlaceholder === ''
    || typeof projectGuidancePlaceholder !== 'string' || projectGuidancePlaceholder === ''
    || !Array.isArray(skills)
    || skills.some((skill) => typeof skill !== 'string'
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(skill))) {
    throw new Error(`invalid shared skills manifest: ${file}`)
  }
  if (new Set(skills).size !== skills.length) {
    throw new Error(`duplicate skill in shared skills manifest: ${file}`)
  }
  return {
    commandPrefixPlaceholder: placeholder,
    packagePathPrefixPlaceholder,
    projectGuidancePlaceholder,
    skills: skills as string[],
  }
}

function readState(file: string): SharedSkillsState {
  if (!existsSync(file)) return { version: 1, skills: {} }
  const parsed = object(JSON.parse(readFileSync(file, 'utf8')))
  const skills = object(parsed?.skills)
  if (parsed?.version !== 1 || skills === undefined
    || Object.keys(skills).some((skill) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(skill))
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
  manifest: SharedSkillsManifest,
  repoRoot: string,
  guidanceRoot: string | undefined,
  target: SharedSkillTarget,
): RenderedFile[] {
  const source = join(packageRoot, 'skills', skill)
  if (!existsSync(join(source, 'SKILL.md'))) {
    throw new Error(`shared skill has no SKILL.md: ${source}`)
  }
  const guidanceFile = guidanceRoot === undefined
    ? undefined
    : projectGuidanceFileForSkill(guidanceRoot, skill)
  const guidance = guidanceFile !== undefined && existsSync(guidanceFile)
    ? readFileSync(guidanceFile, 'utf8')
    : ''
  return filesIn(source).map((file) => {
    let contents = file.contents
    if (file.path === 'SKILL.md') {
      const sourceContents = contents.toString('utf8')
      const injection = guidance === ''
        ? ''
        : `${sourceContents.endsWith('\n') ? '\n' : '\n\n'}${guidance}`
      // The injection point is synthetic and always follows the canonical skill. A
      // literal placeholder in the skill's prose documents the mechanism and must stay.
      const withInjectionPoint = `${sourceContents}${manifest.projectGuidancePlaceholder}`
      const injectionPoint = withInjectionPoint.length - manifest.projectGuidancePlaceholder.length
      contents = Buffer.from(
        `${withInjectionPoint.slice(0, injectionPoint)}${injection}`,
      )
    }
    return {
      ...file,
      contents: target.renderFile(contents, {
        repoRoot,
        packageRoot,
        commandPrefixPlaceholder: manifest.commandPrefixPlaceholder,
        packagePathPrefixPlaceholder: manifest.packagePathPrefixPlaceholder,
      }),
    }
  })
}

/** Every directory this repository's skills must appear in, each listed once. */
function skillTargets(
  repoRoot: string,
  adapters: readonly SharedSkillsAdapter[],
): SharedSkillTarget[] {
  const targets: SharedSkillTarget[] = []
  for (const adapter of adapters) {
    const target: SharedSkillTarget = {
      destinationRoot: adapter.destinationRoot(repoRoot),
      legacyRoots: adapter.legacyRoots?.(repoRoot) ?? [],
      renderFile: (contents, options) => adapter.renderFile(contents, options),
    }
    // One directory has one reader format. A duplicate adapter cannot safely render it
    // again because whichever target ran second would overwrite the first description.
    if (targets.some((existing) => relative(
      existing.destinationRoot, target.destinationRoot,
    ) === '')) continue
    targets.push(target)
  }
  return targets
}

/**
 * Text contents with CRLF folded to LF. Rendered skills are written with LF, but a
 * consumer checkout under `core.autocrlf=true` holds them with CRLF, and nothing in the
 * consumer marks the skill roots `eol=lf`. Comparing raw bytes would report every skill
 * as changed and rewrite it on each sync. A file holding a NUL byte is treated as binary
 * and hashed as is.
 */
function lineEndingNormalized(contents: Buffer): Buffer {
  if (contents.includes(0) || !contents.includes('\r\n')) return contents
  return Buffer.from(contents.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')
}

function hashFiles(files: readonly RenderedFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(lineEndingNormalized(file.contents))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function replaceDirectory(
  destination: string,
  files: readonly RenderedFile[],
  os: OperatingSystem,
): void {
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
      os.removeDirectory(backup)
    } catch (error) {
      os.removeDirectory(destination)
      renameSync(backup, destination)
      throw error
    }
  } finally {
    os.removeDirectory(temporary)
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

function migrateLegacySkills(
  legacyRoots: readonly string[],
  destinationRoot: string,
  os: OperatingSystem,
): Pick<SharedSkillsSyncResult, 'migrationConflicts' | 'changedPaths'> {
  const migrationConflicts: string[] = []
  const changedPaths: string[] = []
  for (const legacyRoot of legacyRoots) {
    const legacyStateFile = join(legacyRoot, STATE_FILE)
    if (relative(legacyRoot, destinationRoot) === '' || !existsSync(legacyStateFile)) continue

    const legacyState = readState(legacyStateFile)
    for (const [skill, previousHash] of Object.entries(legacyState.skills)) {
      const legacySkill = join(legacyRoot, skill)
      if (!existsSync(legacySkill)) continue
      if (!lstatSync(legacySkill).isDirectory()
        || hashFiles(filesIn(legacySkill)) !== previousHash) {
        migrationConflicts.push(legacySkill)
        continue
      }
      os.removeDirectory(legacySkill)
      changedPaths.push(legacySkill)
    }
    rmSync(legacyStateFile)
    changedPaths.push(legacyStateFile)
  }
  return { migrationConflicts, changedPaths }
}

/**
 * Materialize the package's declared shared skills into one target directory. The state
 * records which skill trees the core owns. Later syncs replace those trees, including
 * consumer edits, added support files, and deletions; unrecorded skills remain untouched.
 */
function syncTarget(
  repoRoot: string,
  packageRoot: string,
  guidanceRoot: string | undefined,
  target: SharedSkillTarget,
  os: OperatingSystem,
): SharedSkillsSyncResult {
  const manifest = readManifest(packageRoot)
  const destinationRoot = target.destinationRoot
  const repositoryPath = relative(repoRoot, destinationRoot)
  if (repositoryPath === '' || repositoryPath === '..'
    || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) {
    throw new Error(`shared skill destination escaped the repository: ${destinationRoot}`)
  }
  // Skill names alone cannot say which directory reported them once several are served.
  const reported = (skill: string): string =>
    `${repositoryPath.replaceAll('\\', '/')}/${skill}`
  const stateFile = join(destinationRoot, STATE_FILE)
  // Rendering can fail independently for each skill. Finish it for the whole target
  // before migrating or replacing anything so failed rendering cannot leave an updated
  // directory paired with its stale state hash.
  const desiredSkills = manifest.skills.map((skill) => {
    const files = renderedSkill(packageRoot, skill, manifest, repoRoot, guidanceRoot, target)
    return { skill, files, hash: hashFiles(files) }
  })
  const migration = migrateLegacySkills(target.legacyRoots, destinationRoot, os)
  mkdirSync(destinationRoot, { recursive: true })
  const state = readState(stateFile)
  const nextState: SharedSkillsState = { version: 1, skills: { ...state.skills } }
  const installed: string[] = []
  const updated: string[] = []
  const conflicts: string[] = []
  const changedPaths: string[] = [...migration.changedPaths]
  const managedPaths: string[] = []

  for (const { skill, files: desiredFiles, hash: desiredHash } of desiredSkills) {
    const destination = join(destinationRoot, skill)
    const previousHash = state.skills[skill]
    if (existsSync(destination)) {
      if (!lstatSync(destination).isDirectory()) {
        conflicts.push(reported(skill))
        continue
      }
      const currentHash = hashFiles(filesIn(destination))
      if (currentHash === desiredHash) {
        if (previousHash !== undefined) {
          nextState.skills[skill] = desiredHash
          managedPaths.push(destination)
          if (previousHash !== desiredHash) updated.push(reported(skill))
        }
        continue
      }
      if (previousHash === undefined) {
        conflicts.push(reported(skill))
        continue
      }
      replaceDirectory(destination, desiredFiles, os)
      nextState.skills[skill] = desiredHash
      updated.push(reported(skill))
      changedPaths.push(destination)
      managedPaths.push(destination)
      continue
    }
    if (previousHash !== undefined) {
      replaceDirectory(destination, desiredFiles, os)
      nextState.skills[skill] = desiredHash
      updated.push(reported(skill))
      changedPaths.push(destination)
      managedPaths.push(destination)
      continue
    }
    replaceDirectory(destination, desiredFiles, os)
    nextState.skills[skill] = desiredHash
    installed.push(reported(skill))
    changedPaths.push(destination)
    managedPaths.push(destination)
  }

  if (installed.length > 0 || updated.length > 0) {
    writeState(stateFile, nextState)
    changedPaths.push(stateFile)
  }
  if (Object.keys(nextState.skills).length > 0) managedPaths.push(stateFile)
  return {
    installed,
    updated,
    conflicts,
    migrationConflicts: migration.migrationConflicts,
    removedPaths: migration.changedPaths,
    changedPaths,
    managedPaths,
    failures: [],
  }
}

/**
 * Install the declared shared skills once per user, for every agent that reads skills
 * from the user's home, rendered to run against the fleet. A fleet project's repository
 * holds no orchestration files, so this is where an interactive agent finds them. The
 * per-destination state still records what the core owns: a skill the user wrote under
 * the same name is reported as a conflict, never overwritten.
 */
export function installUserSkills(
  fleetDir: string,
  packageRoot: string,
  adapters: readonly SharedSkillsAdapter[],
  home: string = homedir(),
  os: OperatingSystem = operatingSystem,
): SharedSkillsSyncResult {
  const combined: SharedSkillsSyncResult = {
    installed: [], updated: [], conflicts: [], migrationConflicts: [],
    removedPaths: [], changedPaths: [], managedPaths: [], failures: [],
  }
  const commandPrefix = fleetCommandPrefix(fleetDir, packageRoot)
  const packagePrefix = `${shellPathSpelling(packageRoot)}/`
  const destinations: string[] = []
  for (const adapter of adapters) {
    const destinationRoot = adapter.userDestinationRoot?.(home)
    if (destinationRoot === undefined
      || destinations.some((existing) => relative(existing, destinationRoot) === '')) continue
    destinations.push(destinationRoot)
    let result: SharedSkillsSyncResult
    try {
      result = syncTarget(home, packageRoot, undefined, {
        destinationRoot,
        legacyRoots: [],
        renderFile: (contents, options) => adapter.renderFile(contents, {
          ...options, commandPrefix, packagePathPrefix: packagePrefix,
        }),
      }, os)
    } catch (error) {
      combined.failures.push(error instanceof Error ? error.message : String(error))
      continue
    }
    for (const key of Object.keys(combined) as (keyof SharedSkillsSyncResult)[]) {
      combined[key].push(...result[key])
    }
  }
  return combined
}

/**
 * Materialize the declared shared skills for every agent that discovers skills in this
 * repository, with the guidance found under the project's asset directory. A target that
 * fails is reported through its own error rather than leaving the remaining targets
 * unserved: losing one reader's workflows must not lose the others'.
 */
export function syncSharedSkills(
  repoRoot: string,
  packageRoot: string,
  adapters: readonly SharedSkillsAdapter[],
  guidanceRoot: string,
  os: OperatingSystem = operatingSystem,
  skippedDestinationRoots: readonly string[] = [],
): SharedSkillsSyncResult {
  const combined: SharedSkillsSyncResult = {
    installed: [], updated: [], conflicts: [], migrationConflicts: [],
    removedPaths: [], changedPaths: [], managedPaths: [], failures: [],
  }
  for (const target of skillTargets(repoRoot, adapters)) {
    if (skippedDestinationRoots.some((root) => relative(root, target.destinationRoot) === '')) {
      continue
    }
    let result: SharedSkillsSyncResult
    try {
      result = syncTarget(repoRoot, packageRoot, guidanceRoot, target, os)
    } catch (error) {
      // Files another target already wrote are still owed a report: throwing here would
      // leave them on disk with nothing naming them to the consumer commit path.
      combined.failures.push(error instanceof Error ? error.message : String(error))
      continue
    }
    for (const key of Object.keys(combined) as (keyof SharedSkillsSyncResult)[]) {
      combined[key].push(...result[key])
    }
  }
  return combined
}
