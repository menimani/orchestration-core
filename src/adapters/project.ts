import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

// The project adapter carries everything the orchestration knows about the repository
// it runs in: which checks verify a merge, which suites prove a cycle's tip, and which
// paths make each of them relevant. The core executes these declarations and owns the
// generic behavior — output capture, failure attribution, stop decisions — so porting
// the orchestration to another repository means writing a project adapter and nothing
// else, exactly as porting to another forge means writing a forge adapter.

export interface MergeCheck {
  label: string
  /** Directory the command runs in, relative to the worktree root ('' = the root). */
  cwd: string
  command: string
  /** Whether the changed paths make this check relevant; undefined = always runs. */
  appliesTo?: (changedFiles: string[]) => boolean
  /** Skip silently when this worktree-relative path does not exist. */
  requires?: string
  /** Skip when this worktree-relative path exists — for fallbacks a successor replaces. */
  unless?: string
  /** Run an install command first when a worktree-relative dependency path is missing. */
  installWhenMissing?: { path: string; command: string }
}

export interface SuiteStep {
  label: string
  /** Directory the command runs in, relative to the repository root ('' = the root). */
  cwd: string
  command: string
  /** Run at the cycle gate under every task-gate mode, not only the light gate. */
  runAtEveryTaskGate?: boolean
  /** Skip silently when this repo-relative path does not exist. */
  requires?: string
  /** Run a repair command first when a repo-relative path is missing — for a toolchain
   * that breaks in a way reinstalling fixes, which is not the branch's fault. */
  repairWhenMissing?: { path: string; command: string; message: string }
  /** Whether this step needs a running Docker daemon. */
  needsDocker?: boolean
}

export interface DockerProbe {
  /** Command used to verify that the Docker daemon is reachable. */
  command: string
  /** Maximum time to wait for the probe before treating Docker as unavailable. */
  timeoutMs: number
  /** Project-specific recovery guidance when the probe fails. */
  remediation: string
}

export interface InfrastructureFailure {
  /** Short attribution suitable for a merge-failure warning. */
  diagnosis: string
  /** Recovery guidance suitable for a cycle-suite error. */
  remediation: string
}

export interface WorktreeSetupStep {
  label: string
  /** Directory the command runs in, relative to the new worktree root. */
  cwd: string
  command: string
  /** Skip silently when this worktree-relative path does not exist. */
  requires?: string
}

export interface PullRequestCategory {
  /** Section heading used in the generated pull-request body. */
  label: string
  /** Wording used in the final title; omit categories that should not be counted there. */
  title?: { singular: string; plural: string }
}

export interface PullRequestCommit {
  subject: string
  files: string[]
}

export interface PullRequestClassification {
  category: string
  /** Optional screen or domain label shown before the commit subject. */
  area?: string
}

export interface PullRequestChanges {
  files: string[]
  deletedFiles: string[]
  /** Read the branch diff, optionally limited to repository-relative pathspecs. */
  diff(pathspecs?: string[]): string
}

export interface PullRequestPresentation {
  categories: PullRequestCategory[]
  /** Final-title summary when no category configured for title counts has commits. */
  titleFallback: string
  classifyCommit(commit: PullRequestCommit): PullRequestClassification
  /** Unprefixed bullet text; continuation lines may carry their own indentation. */
  detectRisks(changes: PullRequestChanges): string[]
}

export interface ProjectAdapter {
  name: string
  /** Manual production deployment, when this repository has one. */
  deployment?: { workflow: string; revisionUrl: string }
  /** Whether pull requests are expected to receive CI checks. Omit when unknown. */
  ciChecksExpected?: boolean
  /** Verify that passing merge checks did not borrow Node modules from a parent checkout. */
  verifyDependencyIsolation?: boolean
  /** Per-merge verification, selected from the paths the worktree touched. */
  mergeChecks(taskGate: 'full' | 'light'): MergeCheck[]
  /** Fast checks run by the core-owned pre-commit hook against staged paths. */
  preCommitChecks: MergeCheck[]
  /** Suites the cycle gate runs against the branch tip. Steps default to light gates only. */
  cycleSuite(): SuiteStep[]
  /** Repository-specific probe used when a cycle suite step needs Docker. */
  cycleSuiteDockerProbe?: DockerProbe
  /** Classify repository-specific infrastructure failures found in command output. */
  classifyInfrastructureFailure?: (output: string) => InfrastructureFailure | undefined
  /** Repository-specific preparation required before a scan can inspect a fresh worktree. */
  scanWorktreeSetup?: WorktreeSetupStep[]
  /** Preparation required in the integration worktree before the loop uses it. */
  integrationWorktreeSetup?: WorktreeSetupStep[]
  /** Repository-specific classification and risk signals for the generated pull request. */
  pullRequest: PullRequestPresentation
}

interface ProjectAdapterValidation {
  candidate: boolean
  problem?: string
}

interface RequiredMemberBase {
  name: string
  expected: string
  valid: (value: unknown) => boolean
}

type RequiredMember = RequiredMemberBase & (
  | { scaffoldValue: string | ((projectName: string) => string); children?: never }
  | { scaffoldValue?: never; children: RequiredMember[] }
)

// This is both the runtime contract and the scaffold source. Adding a required member
// here therefore changes validation and every adapter generated after that change.
const PROJECT_ADAPTER_CONTRACT: RequiredMember[] = [
  {
    name: 'name',
    expected: 'a non-empty string',
    valid: (value) => typeof value === 'string' && value !== '',
    scaffoldValue: (projectName) => JSON.stringify(projectName),
  },
  {
    name: 'mergeChecks',
    expected: 'a function',
    valid: (value) => typeof value === 'function',
    scaffoldValue: '() => []',
  },
  {
    name: 'preCommitChecks',
    expected: 'an array',
    valid: Array.isArray,
    scaffoldValue: '[]',
  },
  {
    name: 'cycleSuite',
    expected: 'a function',
    valid: (value) => typeof value === 'function',
    scaffoldValue: '() => []',
  },
  {
    name: 'pullRequest',
    expected: 'an object',
    valid: (value) => typeof value === 'object' && value !== null,
    children: [
      {
        name: 'categories', expected: 'an array', valid: Array.isArray,
        scaffoldValue: "[{ label: 'Changes', title: { singular: 'change', plural: 'changes' } }]",
      },
      {
        name: 'titleFallback', expected: 'a string',
        valid: (value) => typeof value === 'string', scaffoldValue: "'tooling only'",
      },
      {
        name: 'classifyCommit', expected: 'a function',
        valid: (value) => typeof value === 'function',
        scaffoldValue: "() => ({ category: 'Changes' })",
      },
      {
        name: 'detectRisks', expected: 'a function',
        valid: (value) => typeof value === 'function', scaffoldValue: '() => []',
      },
    ],
  },
]

function requiredMemberProblem(
  owner: Record<string, unknown>,
  members: RequiredMember[],
): string | undefined {
  for (const member of members) {
    if (!(member.name in owner)) return `is missing required member '${member.name}'`
    const value = owner[member.name]
    if (!member.valid(value)) {
      return `has invalid required member '${member.name}' (expected ${member.expected})`
    }
    if (member.children !== undefined) {
      const childProblem = requiredMemberProblem(value as Record<string, unknown>, member.children)
      if (childProblem !== undefined) return childProblem
    }
  }
  return undefined
}

export function renderProjectAdapter(projectName: string, typeImport: string): string {
  const renderMember = (member: RequiredMember, indent: string): string =>
    renderScaffoldMember(member, indent, '\n', projectName)
  const members = PROJECT_ADAPTER_CONTRACT.map((member) => renderMember(member, '  ')).join('\n\n')
  return `import type { ProjectAdapter } from '${typeImport}'

export const project: ProjectAdapter = {
${members}
}
`
}

export interface ProjectAdapterRepair {
  source: string
  addedMembers: string[]
  problem?: string
}

interface SourceInsertion {
  position: number
  text: string
}

function renderScaffoldMember(
  member: RequiredMember,
  indent: string,
  newline: string,
  projectName: string,
): string {
  if (member.children === undefined) {
    const value = typeof member.scaffoldValue === 'function'
      ? member.scaffoldValue(projectName)
      : member.scaffoldValue
    return `${indent}${member.name}: ${value},`
  }
  const children = member.children
    .map((child) => renderScaffoldMember(child, `${indent}  `, newline, projectName))
    .join(newline)
  return `${indent}${member.name}: {${newline}${children}${newline}${indent}},`
}

function declaredPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isSpreadAssignment(property)) return undefined
  const name = property.name
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text
  }
  return undefined
}

function propertyInitializer(
  property: ts.ObjectLiteralElementLike,
): ts.Expression | undefined {
  if (ts.isPropertyAssignment(property)) return property.initializer
  return undefined
}

function lineIndent(source: string, position: number): string {
  const lineStart = Math.max(source.lastIndexOf('\n', position - 1) + 1, 0)
  return source.slice(lineStart, position).match(/^\s*/)?.[0] ?? ''
}

function propertyIndent(
  source: string,
  sourceFile: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
): string {
  const first = object.properties[0]
  if (first !== undefined) {
    const indent = lineIndent(source, first.getStart(sourceFile))
    if (indent !== '') return indent
  }
  return `${lineIndent(source, object.getStart(sourceFile))}  `
}

function hasProjectAdapterType(declaration: ts.VariableDeclaration): boolean {
  const type = declaration.type
  return type !== undefined && ts.isTypeReferenceNode(type)
    && ts.isIdentifier(type.typeName) && type.typeName.text === 'ProjectAdapter'
}

function stringProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): string | undefined {
  const property = object.properties.find((candidate) => declaredPropertyName(candidate) === name)
  const initializer = property === undefined ? undefined : propertyInitializer(property)
  return initializer !== undefined && ts.isStringLiteral(initializer) ? initializer.text : undefined
}

function findProjectObject(
  sourceFile: ts.SourceFile,
  projectName: string,
): ts.ObjectLiteralExpression | undefined {
  const typed: ts.ObjectLiteralExpression[] = []
  const named: ts.ObjectLiteralExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const initializer = node.initializer
      if (initializer !== undefined && ts.isObjectLiteralExpression(initializer)) {
        if (hasProjectAdapterType(node)) typed.push(initializer)
        if (stringProperty(initializer, 'name') === projectName) named.push(initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return named.length === 1 ? named[0] : typed.length === 1 ? typed[0] : undefined
}

function collectRepairInsertions(
  source: string,
  sourceFile: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  members: RequiredMember[],
  path: string,
  newline: string,
  projectName: string,
  insertions: SourceInsertion[],
  addedMembers: string[],
): string | undefined {
  const hasSpread = object.properties.some(ts.isSpreadAssignment)
  const missing: RequiredMember[] = []
  for (const member of members) {
    const property = object.properties.find(
      (candidate) => declaredPropertyName(candidate) === member.name,
    )
    const memberPath = path === '' ? member.name : `${path}.${member.name}`
    if (property === undefined) {
      missing.push(member)
      addedMembers.push(memberPath)
      continue
    }
    if (member.children === undefined) continue
    const initializer = propertyInitializer(property)
    if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) {
      return `cannot safely repair '${memberPath}' because it is not an inline object literal`
    }
    const problem = collectRepairInsertions(
      source, sourceFile, initializer, member.children, memberPath, newline, projectName,
      insertions, addedMembers,
    )
    if (problem !== undefined) return problem
  }

  if (missing.length === 0) return undefined
  if (hasSpread) {
    return `cannot safely repair '${path || 'project'}' because it contains a spread assignment`
  }
  const indent = propertyIndent(source, sourceFile, object)
  const closingPosition = object.getEnd() - 1
  const closingIndent = lineIndent(source, closingPosition)
  const closingLineStart = Math.max(source.lastIndexOf('\n', closingPosition - 1) + 1, 0)
  const closingOnOwnLine = /^\s*$/.test(source.slice(closingLineStart, closingPosition))
  const rendered = missing.map((member) => [
    `${indent}// GENERATED by init: replace with this project's real values.`,
    renderScaffoldMember(member, indent, newline, projectName),
  ].join(newline)).join(newline)
  if (object.properties.length > 0 && !object.properties.hasTrailingComma) {
    insertions.push({ position: object.properties.at(-1)!.getEnd(), text: ',' })
  }
  const firstLine = closingOnOwnLine && rendered.startsWith(closingIndent)
    ? rendered.slice(closingIndent.length)
    : `${newline}${rendered}`
  insertions.push({
    position: closingPosition,
    text: `${firstLine}${newline}${closingIndent}`,
  })
  return undefined
}

/** Add scaffold defaults for absent required members without reprinting existing source. */
export function repairProjectAdapterSource(
  source: string,
  projectName: string,
): ProjectAdapterRepair {
  const sourceFile = ts.createSourceFile(
    'project-adapter.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  )
  const object = findProjectObject(sourceFile, projectName)
  if (object === undefined) {
    return {
      source,
      addedMembers: [],
      problem: `could not find one inline ProjectAdapter declaration for project '${projectName}'`,
    }
  }

  const declaredName = stringProperty(object, 'name')
  if (declaredName !== undefined && declaredName !== projectName) {
    return {
      source,
      addedMembers: [],
      problem: `declares project name '${declaredName}' but adapter filename requires '${projectName}'`,
    }
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const insertions: SourceInsertion[] = []
  const addedMembers: string[] = []
  const problem = collectRepairInsertions(
    source, sourceFile, object, PROJECT_ADAPTER_CONTRACT, '', newline, projectName,
    insertions, addedMembers,
  )
  if (problem !== undefined) return { source, addedMembers: [], problem }

  let repaired = source
  for (const insertion of insertions.sort((left, right) => right.position - left.position)) {
    repaired = repaired.slice(0, insertion.position) + insertion.text
      + repaired.slice(insertion.position)
  }
  return { source: repaired, addedMembers }
}

function validateProjectAdapter(value: unknown, name?: string): ProjectAdapterValidation {
  if (typeof value !== 'object' || value === null) return { candidate: false }
  const candidate = value as Partial<ProjectAdapter>
  if (typeof candidate.name !== 'string' || candidate.name === '') return { candidate: false }
  if (name !== undefined && candidate.name !== name) return { candidate: false }

  const topLevel = candidate as Record<string, unknown>
  return { candidate: true, problem: requiredMemberProblem(topLevel, PROJECT_ADAPTER_CONTRACT) }
}

function discoverProjectAdapter(orchestrationRoot: string): { path: string; name: string } {
  const projectDirectory = resolve(orchestrationRoot, 'project')
  const adapters = existsSync(projectDirectory)
    ? readdirSync(projectDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^project-.+\.ts$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    : []

  if (adapters.length !== 1) {
    const found = adapters.length === 0 ? '(none)' : adapters.join(', ')
    throw new Error(
      `Could not discover project adapter in ${projectDirectory}: found ${found}. `
      + 'Expected exactly one project-*.ts file; PROJECT selects between them.',
    )
  }

  const filename = adapters[0]!
  return {
    path: resolve(projectDirectory, filename),
    name: basename(filename, '.ts').slice('project-'.length),
  }
}

interface ResolvedProjectAdapter {
  path: string
  name?: string
}

function resolveProjectAdapter(
  orchestrationRoot: string,
  env: NodeJS.ProcessEnv,
): ResolvedProjectAdapter {
  const configuredName = env['PROJECT'] === undefined || env['PROJECT'] === ''
    ? undefined
    : env['PROJECT']
  const configuredPath = env['PROJECT_ADAPTER'] === undefined || env['PROJECT_ADAPTER'] === ''
    ? undefined
    : env['PROJECT_ADAPTER']
  const discovered = configuredName === undefined && configuredPath === undefined
    ? discoverProjectAdapter(orchestrationRoot)
    : undefined
  const name = configuredName ?? discovered?.name
  return {
    name,
    path: configuredPath !== undefined
      ? resolve(orchestrationRoot, configuredPath)
      : discovered?.path ?? resolve(orchestrationRoot, 'project', `project-${name}.ts`),
  }
}

export interface MonitoredProjectAdapter {
  project: ProjectAdapter
  path: string
  sourceChanged: () => boolean
}

async function importProject(adapterPath: string, name?: string): Promise<ProjectAdapter> {
  const mod = await import(pathToFileURL(adapterPath).href) as Record<string, unknown>
  let matchingProblem: string | undefined
  for (const value of Object.values(mod)) {
    const validation = validateProjectAdapter(value, name)
    if (!validation.candidate) continue
    if (validation.problem === undefined) return value as ProjectAdapter
    matchingProblem ??= validation.problem
  }
  if (matchingProblem !== undefined) {
    const projectName = name ?? 'the matching project'
    throw new Error(
      `Project adapter '${adapterPath}' exports project '${projectName}' but ${matchingProblem}`,
    )
  }
  const expected = name === undefined ? 'a project adapter' : `project '${name}'`
  throw new Error(`Project adapter '${adapterPath}' does not export ${expected}`)
}

const LOCAL_MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']

function resolveLocalModule(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined
  const imported = resolve(dirname(importer), specifier)
  const candidates = extname(imported) === ''
    ? [imported, ...LOCAL_MODULE_EXTENSIONS.map((extension) => `${imported}${extension}`),
        ...LOCAL_MODULE_EXTENSIONS.map((extension) => resolve(imported, `index${extension}`))]
    : [imported]
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

function projectSources(adapterPath: string): Map<string, Buffer> {
  const sources = new Map<string, Buffer>()
  const pending = [adapterPath]
  while (pending.length > 0) {
    const path = pending.pop()!
    if (sources.has(path)) continue
    const source = readFileSync(path)
    sources.set(path, source)
    const imports = ts.preProcessFile(source.toString('utf8'), true, true).importedFiles
    for (const imported of imports) {
      const dependency = resolveLocalModule(path, imported.fileName)
      if (dependency !== undefined && !sources.has(dependency)) pending.push(dependency)
    }
  }
  return sources
}

function projectSourcesChanged(expected: ReadonlyMap<string, Buffer>, adapterPath: string): boolean {
  try {
    const current = projectSources(adapterPath)
    return current.size !== expected.size
      || [...expected].some(([path, source]) => !current.get(path)?.equals(source))
  } catch {
    // A missing or unreadable dependency is as stale as a missing adapter.
    return true
  }
}

/** Load an adapter and retain every local source the daemon must stop using if it changes. */
export async function loadMonitoredProject(
  orchestrationRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MonitoredProjectAdapter> {
  const resolved = resolveProjectAdapter(orchestrationRoot, env)
  if (!existsSync(resolved.path)) {
    throw new Error(`Project adapter not found: ${resolved.path}`)
  }

  const sourcesBeforeImport = projectSources(resolved.path)
  const project = await importProject(resolved.path, resolved.name)
  const sources = projectSources(resolved.path)
  if (projectSourcesChanged(sourcesBeforeImport, resolved.path)) {
    throw new Error(`Project adapter changed while it was loading: ${resolved.path}`)
  }
  return {
    project,
    path: resolved.path,
    sourceChanged: () => projectSourcesChanged(sources, resolved.path),
  }
}

export async function loadProject(
  orchestrationRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectAdapter> {
  const resolved = resolveProjectAdapter(orchestrationRoot, env)
  if (!existsSync(resolved.path)) {
    throw new Error(`Project adapter not found: ${resolved.path}`)
  }
  return importProject(resolved.path, resolved.name)
}
