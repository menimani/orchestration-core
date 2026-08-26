import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  renameSync: vi.fn(), rmSync: vi.fn(), writeFileSync: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    renameSync: mocks.renameSync,
    rmSync: mocks.rmSync,
    writeFileSync: mocks.writeFileSync,
  }
})

import { mergeTask, MergeError } from '../src/merge.ts'
import { branchName, orchPaths, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { stubProject } from './stubProject.ts'

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
let repoRoot = ''
let paths: OrchPaths

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeCompletedTask(
  taskId: string,
  options: { commit?: boolean; dirty?: boolean } = {},
): Promise<void> {
  writeFileSync(specFile(paths, taskId), '# spec\n')
  const worktree = worktreeDir(paths, taskId)
  git(repoRoot, ['worktree', 'add', worktree, '-b', branchName(taskId)])
  if (options.commit === true) {
    writeFileSync(join(worktree, `${taskId}.txt`), 'work\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'feat: add task work'])
  }
  if (options.dirty === true) writeFileSync(join(worktree, 'uncommitted.txt'), 'dirty\n')
  await writeStatus(paths, taskId, 'completed')
}

beforeEach(() => {
  mocks.rmSync.mockReset().mockImplementation((...args: unknown[]) =>
    Reflect.apply(actualFs.rmSync, actualFs, args))
  mocks.renameSync.mockReset().mockImplementation((...args: unknown[]) =>
    Reflect.apply(actualFs.renameSync, actualFs, args))
  mocks.writeFileSync.mockReset().mockImplementation((...args: unknown[]) =>
    Reflect.apply(actualFs.writeFileSync, actualFs, args))
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-merge-guard-'))
  paths = orchPaths(repoRoot)
  git(repoRoot, ['init', '-q', '-b', 'main'])
  git(repoRoot, ['config', 'user.email', 'test@example.com'])
  git(repoRoot, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
  git(repoRoot, ['add', '-A'])
  git(repoRoot, ['commit', '-qm', 'chore: initial commit'])
})

afterEach(() => {
  vi.restoreAllMocks()
  actualFs.rmSync(repoRoot, { recursive: true, force: true })
})

describe('merge guard retirement', () => {
  it('reclaims a failed merge when guard retirement marker and rename both fail', async () => {
    const taskId = '20260826_203919_001_auto-failed-guard-retirement'
    await makeCompletedTask(taskId, { dirty: true })
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mocks.writeFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === join(guard, 'retired')) throw new Error('retirement marker failed')
      return Reflect.apply(actualFs.writeFileSync, actualFs, args)
    })
    mocks.renameSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === guard) throw new Error('guard retirement rename failed')
      return Reflect.apply(actualFs.renameSync, actualFs, args)
    })

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject,
    })).rejects.toBeInstanceOf(MergeError)
    expect(actualFs.existsSync(join(guard, 'retired'))).toBe(false)

    const onMergeStart = vi.fn()
    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, onMergeStart,
    })).rejects.toBeInstanceOf(MergeError)
    expect(onMergeStart).toHaveBeenCalledOnce()
  })

  it('reclaims a failed merge after guard retirement rename fails', async () => {
    const taskId = '20260822_093823_001_auto-failed-guard-rename'
    await makeCompletedTask(taskId, { dirty: true })
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mocks.renameSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === guard) throw new Error('guard retirement rename failed')
      return Reflect.apply(actualFs.renameSync, actualFs, args)
    })

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject,
    })).rejects.toBeInstanceOf(MergeError)
    expect(actualFs.existsSync(join(guard, 'retired'))).toBe(true)

    const onMergeStart = vi.fn()
    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, onMergeStart,
    })).rejects.toBeInstanceOf(MergeError)
    expect(onMergeStart).toHaveBeenCalledOnce()
  })

  it('does not turn a successful merge into failure when guard retirement rename fails', async () => {
    const taskId = '20260822_093823_002_auto-successful-guard-rename'
    await makeCompletedTask(taskId, { commit: true })
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mocks.renameSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === guard) throw new Error('guard retirement rename failed')
      return Reflect.apply(actualFs.renameSync, actualFs, args)
    })

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject,
    })).resolves.toMatchObject({ outcome: 'merged' })
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(actualFs.existsSync(join(guard, 'retired'))).toBe(true)
  })

  it('releases a failed merge before non-fatal retired guard cleanup', async () => {
    const taskId = '20260820_205825_001_auto-failed-guard-cleanup'
    await makeCompletedTask(taskId, { dirty: true })
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    const cleanupFailure = new Error('retired guard cleanup failed')
    mocks.rmSync.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('.retired-')) throw cleanupFailure
      return Reflect.apply(actualFs.rmSync, actualFs, args)
    })

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject,
    })).rejects.toBeInstanceOf(MergeError)
    expect(actualFs.existsSync(guard)).toBe(false)

    const onMergeStart = vi.fn()
    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, onMergeStart,
    })).rejects.toBeInstanceOf(MergeError)
    expect(onMergeStart).toHaveBeenCalledOnce()
  })

  it('does not turn successful merge into failure when retired guard cleanup fails', async () => {
    const taskId = '20260820_205825_002_auto-successful-guard-cleanup'
    await makeCompletedTask(taskId, { commit: true })
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mocks.rmSync.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('.retired-')) throw new Error('retired guard cleanup failed')
      return Reflect.apply(actualFs.rmSync, actualFs, args)
    })

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject,
    })).resolves.toMatchObject({ outcome: 'merged' })
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(actualFs.existsSync(guard)).toBe(false)
  })
})
