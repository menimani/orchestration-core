// The setup the merge test files share: the fixture repository, the task and project
// fixtures, the removal runtimes, and the hooks that create and remove the repository
// around every test.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { OperatingSystem } from '../src/adapters/os.ts'
import { createOperatingSystem as createPosixOperatingSystem } from '../src/adapters/os-posix.ts'
import { createOperatingSystem as createWindowsOperatingSystem } from '../src/adapters/os-windows.ts'
import { branchName, orchPaths, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import type { WorktreeRemovalRuntime } from '../src/worktree.ts'
import { buildRepositoryTemplate, type RepositoryTemplate } from './repositoryTemplate.ts'
import { stubProject } from './stubProject.ts'
import { PROCESS_TEST_TIMEOUT_MS, TestProcessRegistry } from './testProcess.ts'


export let repoRoot: string
export let paths: OrchPaths
export const testProcesses = new TestProcessRegistry()

export async function waitForFile(file: string, message: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TEST_TIMEOUT_MS
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export const installProject: ProjectAdapter = {
  ...stubProject,
  name: 'install-test',
  verifyDependencyIsolation: true,
  mergeChecks: () => [{
    label: 'Fixture check',
    cwd: '',
    command: 'node -e "console.error(\'check warning\'); console.log(\'check ran\')"',
    installWhenMissing: {
      path: 'dependency-ready',
      command: 'node -e "console.log(\'install ran\')"',
    },
  }],
  cycleSuite: () => [],
}

export const noCheckProject: ProjectAdapter = {
  ...stubProject,
  name: 'no-check',
  mergeChecks: () => [],
  cycleSuite: () => [],
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

export function expectNoTemporaryWorktree(prefix: '.merge-' | '.adopt-'): void {
  expect(readdirSync(paths.worktreesDir).filter((name) => name.startsWith(prefix))).toEqual([])
  expect(git(repoRoot, ['worktree', 'list', '--porcelain'])).not.toContain(prefix)
}

export function repositoryState(): { head: string; status: string; worktrees: string } {
  return {
    head: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    status: git(repoRoot, ['status', '--porcelain']),
    worktrees: git(repoRoot, ['worktree', 'list', '--porcelain']),
  }
}

export function windowsOperatingSystem(remove: (path: string, options: {
  force: true
  maxRetries?: 3
  recursive: true
}) => void): OperatingSystem {
  return createWindowsOperatingSystem({
    spawn: () => {}, listProcesses: () => [], probeProcess: () => {}, remove,
    now: Date.now, sleep: () => {},
  })
}

export function posixOperatingSystem(remove: (path: string, options: {
  force: true
  recursive: true
}) => void): OperatingSystem {
  return createPosixOperatingSystem({
    signalProcessGroup: () => {}, probeProcess: () => {}, remove,
    now: Date.now, sleep: () => {}, groupHasRunningMember: () => undefined,
  })
}

export function failedWorktreeRemovalRuntime(): WorktreeRemovalRuntime {
  return {
    os: posixOperatingSystem(() => { throw new Error('Direct removal failed') }),
    git: (_cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('Git removal failed')
      }
      return ''
    },
  }
}

export function staleMetadataRemovalRuntime(): WorktreeRemovalRuntime {
  return {
    os: posixOperatingSystem((path, options) => { rmSync(path, options) }),
    git: (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('Git removal failed')
      }
      if (args[0] === 'worktree' && args[1] === 'prune') {
        throw new Error('metadata is locked')
      }
      return git(cwd, args)
    },
  }
}

export async function makeCompletedTask(taskId: string, options: { commit?: boolean; dirty?: boolean } = {}): Promise<string> {
  writeFileSync(specFile(paths, taskId), '# spec\n')
  const worktree = worktreeDir(paths, taskId)
  git(repoRoot, ['worktree', 'add', worktree, '-b', branchName(taskId)])
  if (options.commit === true) {
    writeFileSync(join(worktree, `${taskId}.txt`), 'work\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'feat: add task work'])
  }
  if (options.dirty === true) {
    writeFileSync(join(worktree, 'uncommitted.txt'), 'left behind\n')
  }
  await writeStatus(paths, taskId, 'completed')
  return worktree
}

let initialRepository: RepositoryTemplate<void> | undefined

beforeAll(() => {
  initialRepository = buildRepositoryTemplate((root) => {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'README.md'), '# repo\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'chore: initial commit'])
  })
})

afterAll(() => {
  initialRepository?.dispose()
})

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-merge-'))
  initialRepository!.copyTo(repoRoot)
  paths = orchPaths(repoRoot)
})

afterEach(async () => {
  await testProcesses.cleanup()
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})
