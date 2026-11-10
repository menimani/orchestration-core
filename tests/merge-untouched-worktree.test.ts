import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import { createOperatingSystem as createPosixOperatingSystem } from '../src/adapters/os-posix.ts'
import { mergeTask, removeTemporaryWorktree } from '../src/merge.ts'
import { branchName, orchPaths, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { buildRepositoryTemplate, type RepositoryTemplate } from './repositoryTemplate.ts'
import { stubProject } from './stubProject.ts'

// Looking for the processes that hold a worktree lists every process on the host, which
// costs about half a second on Windows. A prospective merge worktree that no gate command
// ran in holds nothing, so its removal skips that lookup; the task worktree never does.

let repoRoot: string
let paths: OrchPaths
let initialRepository: RepositoryTemplate<void> | undefined

function checkProject(command: string): ProjectAdapter {
  return {
    ...stubProject,
    name: 'untouched-check',
    mergeChecks: () => [{ label: 'Fixture check', cwd: '', command }],
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeCompletedTask(taskId: string): Promise<string> {
  writeFileSync(specFile(paths, taskId), '# spec\n')
  const worktree = worktreeDir(paths, taskId)
  git(repoRoot, ['worktree', 'add', '-q', worktree, '-b', branchName(taskId)])
  writeFileSync(join(worktree, `${taskId}.txt`), 'work\n')
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-qm', 'feat: add task work'])
  await writeStatus(paths, taskId, 'completed')
  return worktree
}

/** Record each worktree the merge looks for holders of, without looking. */
function recordScans(): string[] {
  const scanned: string[] = []
  vi.spyOn(operatingSystem, 'terminateWorktreeProcesses').mockImplementation((path) => {
    scanned.push(path)
  })
  return scanned
}

const prospective = (scanned: string[]): string[] =>
  scanned.filter((path) => basename(path).startsWith('.merge-'))

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

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-merge-untouched-'))
  initialRepository!.copyTo(repoRoot)
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('prospective merge worktree removal', () => {
  it('skips the process scan when no check ran, but still scans the task worktree', async () => {
    const taskId = '20261111_000000_001_user-no-check'
    const worktree = await makeCompletedTask(taskId)
    const scanned = recordScans()

    await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })

    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(prospective(scanned)).toEqual([])
    expect(scanned).toEqual([worktree])
  })

  it('scans both worktrees when a check command ran', async () => {
    const taskId = '20261111_000000_002_user-check-ran'
    const worktree = await makeCompletedTask(taskId)
    const scanned = recordScans()

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: checkProject('node -e "process.exit(0)"'),
    })

    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(prospective(scanned)).toHaveLength(1)
    expect(scanned).toContain(worktree)
  })

  it('scans the prospective worktree when its check failed', async () => {
    const taskId = '20261111_000000_003_user-check-failed'
    await makeCompletedTask(taskId)
    const scanned = recordScans()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: checkProject('node -e "process.exit(1)"'),
    })).rejects.toThrow('Tests failed. Aborting merge.')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(prospective(scanned)).toHaveLength(1)
  })

  it('counts an explicit test command as a command run in the worktree', async () => {
    const taskId = '20261111_000000_004_user-test-command'
    const worktree = await makeCompletedTask(taskId)
    const scanned = recordScans()

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, testCmd: 'node -e "process.exit(0)"',
    })

    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(prospective(scanned)).toHaveLength(1)
    expect(scanned).toContain(worktree)
  })
})

describe('removeTemporaryWorktree', () => {
  const runtime = (calls: string[]) => ({
    os: {
      ...createPosixOperatingSystem({
        signalProcessGroup: () => {}, probeProcess: () => {}, remove: () => {},
        now: Date.now, sleep: () => {}, groupHasRunningMember: () => undefined,
      }),
      terminateWorktreeProcesses: (path: string) => { calls.push(`terminate ${path}`) },
    },
    git: (_cwd: string, args: string[]) => {
      calls.push(args.join(' '))
      return ''
    },
  })

  it('scans for holders when the caller does not say the worktree is untouched', () => {
    const worktree = join(paths.worktreesDir, '.merge-default')
    const calls: string[] = []

    removeTemporaryWorktree(paths, worktree, vi.fn(), runtime(calls))

    expect(calls).toEqual([`terminate ${worktree}`, `worktree remove ${worktree} --force`])
  })

  it('removes an untouched worktree without scanning for holders', () => {
    const worktree = join(paths.worktreesDir, '.merge-untouched')
    const calls: string[] = []

    removeTemporaryWorktree(paths, worktree, vi.fn(), runtime(calls), { untouched: true })

    expect(calls).toEqual([`worktree remove ${worktree} --force`])
  })
})
