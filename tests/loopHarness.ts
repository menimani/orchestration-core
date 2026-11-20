// The setup the loop test files share: the fixture repository, the fake forge and runner,
// and the hooks that create and remove both around every test. Each file still declares
// its own vi.mock calls, because Vitest hoists a mock only within the file that calls it.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'
import type { Forge, PrStatus } from '../src/adapters/forge.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig, type LoopConfig } from '../src/config.ts'
import { createLoop, type Loop, type LoopDeps } from '../src/loop.ts'
import type { OrchestrationDepsRuntime } from '../src/merge.ts'
import {
  branchName, finalMessageFile, orchPaths, statusFile, worktreeDir, type OrchPaths,
} from '../src/paths.ts'
import { forgetTaskProcess, recordTaskProcess } from '../src/processRegistry.ts'
import { startTask } from '../src/start.ts'
import { enqueueTask, specFile } from '../src/tasks.ts'
import type { TaskProcessTermination } from '../src/taskProcesses.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'
import { FakeRepository } from './fakeRepository.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { buildRepositoryTemplate, type RepositoryTemplate } from './repositoryTemplate.ts'
import { stubProject as sharedStubProject } from './stubProject.ts'
import { TestProcessRegistry } from './testProcess.ts'

export let repoRoot: string
export let paths: OrchPaths
export let logged: string[]
export let forgeStatus: PrStatus
export let prStatusCalls: number
export let runnerStarts: string[]
export let fakeForge: FakeForge
export const testProcesses = new TestProcessRegistry()
// Set by a test whose loop asks its questions of an in-memory checkout instead of git.
let fakeRepository: FakeRepository | undefined

// A test file cannot assign an imported binding, so the state its tests replace has a setter.
export function setPaths(value: OrchPaths): void {
  paths = value
}

export function setLogged(value: string[]): void {
  logged = value
}

export function setForgeStatus(value: PrStatus): void {
  forgeStatus = value
}

/**
 * Describes the test's checkout in memory, as initializeGitRepo leaves it on disk unless
 * the test says otherwise. The loops the test creates afterwards ask it instead of git
 * and start tasks without worktrees; the test fails if they ask what it cannot answer.
 */
export function useFakeRepository(state: ConstructorParameters<typeof FakeRepository>[1] = {}): FakeRepository {
  fakeRepository = new FakeRepository(repoRoot, state)
  return fakeRepository
}

/** The loop dependencies that point at the fake repository, when the test uses one. */
export function fakeRepositoryDeps(): Pick<LoopDeps, 'git' | 'startTask'> {
  return fakeRepository === undefined
    ? {}
    : { git: fakeRepository.git, startTask: fakeRepository.startTask }
}

export function makeForge(): Forge {
  fakeForge = makeFakeForge()
  fakeForge.prStatus = async (ref) => {
    fakeForge.prStatusRefs.push(ref)
    prStatusCalls += 1
    // A fixture that names no head stands for a forge that has caught up with the
    // checkout; a test about a stale forge sets headSha to another commit.
    if (forgeStatus.headSha !== '' || forgeStatus.state !== 'open') return forgeStatus
    let localHead = ''
    try {
      localHead = fakeRepository === undefined
        ? git(['rev-parse', 'HEAD'])
        : fakeRepository.git(repoRoot, ['rev-parse', 'HEAD']).trim()
    } catch {
      localHead = ''
    }
    return { ...forgeStatus, headSha: localHead }
  }
  return fakeForge
}

export function makeRunner(): Runner {
  return {
    sharedSkills: fakeRunnerSharedSkills,
    start: async (options) => {
      runnerStarts.push(options.specFile)
      return process.pid
    },
  }
}

export const stubProject: ProjectAdapter = {
  ...sharedStubProject,
  name: 'stub',
}

export function makeLoop(
  overrides: Partial<LoopConfig> = {},
  project: ProjectAdapter = stubProject,
  orchestrationDepsRuntime?: OrchestrationDepsRuntime,
  clock: () => Date = () => new Date(2026, 7, 8, 12, 0, 0),
  runner: Runner = makeRunner(),
  enqueueTaskImpl: NonNullable<LoopDeps['enqueueTask']> = enqueueTask,
  terminateTaskProcesses?: () => TaskProcessTermination,
  startTaskImpl?: typeof startTask,
): Loop {
  // The fixtures register the test process itself as a runner, with a fixed UTC start
  // that a local-time clock puts hours in the past on some hosts. A deadline would stop
  // the test process there, so only a test that asks for one gets it.
  const config = { ...loadConfig({}), taskDeadlineHours: 0, ...overrides }
  return createLoop({
    paths,
    config,
    forge: makeForge(),
    runner,
    project,
    log: (line) => logged.push(line),
    now: clock,
    orchestrationDepsRuntime,
    enqueueTask: enqueueTaskImpl,
    terminateTaskProcesses,
    ...fakeRepositoryDeps(),
    ...(startTaskImpl === undefined ? {} : { startTask: startTaskImpl }),
  })
}

export function writeFinal(taskId: string, content: string): void {
  writeFileSync(finalMessageFile(paths, taskId), content)
}

export function writeRawStatus(taskId: string, status: string, pid: number | null = null): void {
  writeFileSync(statusFile(paths, taskId),
    JSON.stringify({
      task_id: taskId,
      status,
      pid,
      started_at: '2026-08-08T03:00:00Z',
      updated_at: '2026-08-08T03:00:00Z',
      worktree: worktreeDir(paths, taskId),
      branch: branchName(taskId),
      ...(status === 'merged' ? { merge_commit: 'merge-commit', run_branch: 'main' } : {}),
    }))
  // A running task's process lives in the registry, not in the record.
  if (pid === null) forgetTaskProcess(paths, taskId)
  else recordTaskProcess(paths, taskId, pid)
}

export function logText(): string {
  return logged.join('\n')
}

export function git(args: string[], cwd = repoRoot): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function commitInitialFile(root: string): string {
  git(['init', '--initial-branch=main'], root)
  git(['config', 'user.email', 'loop-test@example.test'], root)
  git(['config', 'user.name', 'Loop Test'], root)
  writeFileSync(join(root, 'tracked.txt'), 'initial\n')
  git(['add', 'tracked.txt'], root)
  git(['commit', '-m', 'initial'], root)
  return git(['rev-parse', 'HEAD'], root)
}

let initialRepository: RepositoryTemplate<string> | undefined
let initialRepositoryWithRemote: RepositoryTemplate<string> | undefined

export function initializeGitRepo(): string {
  initialRepository ??= buildRepositoryTemplate(commitInitialFile)
  initialRepository.copyTo(repoRoot)
  return initialRepository.value
}

/** The state initializeGitRepo then configureRemoteDefaultBranch() leave. */
export function initializeGitRepoWithRemote(): string {
  initialRepositoryWithRemote ??= buildRepositoryTemplate((root) => {
    const head = commitInitialFile(root)
    configureRemoteDefaultBranch('main', 'origin', root)
    return head
  })
  initialRepositoryWithRemote.copyTo(repoRoot)
  git(['remote', 'set-url', 'origin', join(repoRoot, 'origin.git')])
  return initialRepositoryWithRemote.value
}

export function configureLocalRemote(): void {
  initializeGitRepo()
  const remote = join(repoRoot, 'remote.git')
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
  git(['remote', 'add', 'origin', remote])
  git(['push', '-u', 'origin', 'main'])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
}

export function backlogEntries(): string[] {
  const backlog = join(paths.queueDir, 'backlog.txt')
  return existsSync(backlog)
    ? readFileSync(backlog, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    : []
}

export function configureRemoteDefaultBranch(branch = 'main', remoteName = 'origin', root = repoRoot): void {
  const remote = join(root, `${remoteName}.git`)
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
  git(['remote', 'add', remoteName, remote], root)
  git(['push', '-u', remoteName, branch], root)
  execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
    cwd: remote, windowsHide: true,
  })
  git(['symbolic-ref', `refs/remotes/${remoteName}/HEAD`,
    `refs/remotes/${remoteName}/${branch}`], root)
}

export function makeCompletedTask(taskId: string, writeCompletedStatus = true): void {
  writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
  const worktree = worktreeDir(paths, taskId)
  git(['worktree', 'add', worktree, '-b', branchName(taskId)])
  writeFileSync(join(worktree, `${taskId}.txt`), 'completed work\n')
  execFileSync('git', ['add', '-A'], { cwd: worktree })
  execFileSync('git', ['commit', '-qm', 'fix: complete fixture task'], { cwd: worktree })
  writeFinal(taskId, 'TASK_COMPLETE\n')
  if (writeCompletedStatus) writeRawStatus(taskId, 'completed')
}

/**
 * makeCompletedTask for a test on the fake repository: the task's branch exists only
 * there, and its worktree is a plain directory holding the completed work.
 */
export function makeFakeCompletedTask(taskId: string): void {
  if (fakeRepository === undefined) throw new Error('makeFakeCompletedTask needs useFakeRepository first')
  writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
  const worktree = worktreeDir(paths, taskId)
  mkdirSync(worktree, { recursive: true })
  fakeRepository.state.branches.push(branchName(taskId))
  writeFileSync(join(worktree, `${taskId}.txt`), 'completed work\n')
  writeFinal(taskId, 'TASK_COMPLETE\n')
  writeRawStatus(taskId, 'completed')
}

/** A completed local task whose only commit conflicts with a later run-branch commit. */
export function makeConflictingLocalTask(taskId: string): {
  initialHead: string
  runHead: string
  taskTip: string
} {
  const initialHead = initializeGitRepo()
  makeCompletedTask(taskId)
  writeFileSync(specFile(paths, taskId), [
    `# ${taskId}: delegated task`,
    '',
    '## Requirement',
    '',
    'Change the tracked line.',
    '',
    'TASK_COMPLETE',
    '',
  ].join('\n'))
  const worktree = worktreeDir(paths, taskId)
  writeFileSync(join(worktree, 'tracked.txt'), 'task change\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: worktree })
  execFileSync('git', ['commit', '-qm', 'fix: change tracked line'], { cwd: worktree })
  const taskTip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()
  writeFileSync(join(repoRoot, 'tracked.txt'), 'run change\n')
  git(['add', 'tracked.txt'])
  git(['commit', '-m', 'fix: advance run branch'])
  return { initialHead, runHead: git(['rev-parse', 'HEAD']), taskTip }
}

/** Registers the hooks every loop test file runs, in the order they always ran. */
export function registerLoopHooks(): void {
  afterAll(() => {
    initialRepository?.dispose()
    initialRepositoryWithRemote?.dispose()
  })

  beforeEach(() => {
    fakeRepository = undefined
    repoRoot = mkdtempSync(join(tmpdir(), 'orch-loop-'))
    paths = orchPaths(repoRoot)
    logged = []
    prStatusCalls = 0
    runnerStarts = []
    forgeStatus = { state: 'open', isDraft: true, url: 'https://example.test/pull/1', headSha: '', checks: [] }
  })

  afterEach(async () => {
    await testProcesses.cleanup()
    rmSync(repoRoot, { recursive: true, force: true })
    fakeRepository?.assertEveryQuestionAnswered()
  })
}
