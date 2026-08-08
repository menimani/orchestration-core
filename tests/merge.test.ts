import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MergeError, mergeTask, selectChecks } from '../src/merge.ts'
import { branchName, orchPaths, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'

let repoRoot: string
let paths: OrchPaths

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeCompletedTask(taskId: string, options: { commit?: boolean; dirty?: boolean } = {}): Promise<string> {
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

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-merge-'))
  paths = orchPaths(repoRoot)
  git(repoRoot, ['init', '-q', '-b', 'main'])
  git(repoRoot, ['config', 'user.email', 'test@example.com'])
  git(repoRoot, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
  git(repoRoot, ['add', '-A'])
  git(repoRoot, ['commit', '-qm', 'chore: initial commit'])
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('mergeTask', () => {
  it('merges a committed task, removes its worktree and branch, and records merged', async () => {
    const taskId = '20260808_000000_001_user-adds-a-file'
    const worktree = await makeCompletedTask(taskId, { commit: true })

    await mergeTask(paths, taskId, { taskGate: 'light' })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(`Merge ${taskId} via Codex`)
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('stops on uncommitted changes and keeps the worktree', async () => {
    const taskId = '20260808_000000_002_user-forgot-commit'
    const worktree = await makeCompletedTask(taskId, { commit: true, dirty: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light' }))
      .rejects.toThrow(/uncommitted changes/)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('stops a non-inspection task that produced no commits', async () => {
    const taskId = '20260808_000000_003_user-empty-handed'
    const worktree = await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light' }))
      .rejects.toThrow(/no new commits/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('lets a scan through without commits', async () => {
    const taskId = '20260808_000000_004_scan'
    await makeCompletedTask(taskId)
    await mergeTask(paths, taskId, { taskGate: 'light' })
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('refuses a task that is not completed', async () => {
    const taskId = '20260808_000000_005_user-still-going'
    await makeCompletedTask(taskId, { commit: true })
    await writeStatus(paths, taskId, 'running', process.pid)
    await expect(mergeTask(paths, taskId, { taskGate: 'light' }))
      .rejects.toThrow(/not 'completed'/)
  })

  it('aborts the merge when the explicit test command fails', async () => {
    const taskId = '20260808_000000_006_user-tests-fail'
    await makeCompletedTask(taskId, { commit: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', testCmd: 'node -e "process.exit(1)"' }))
      .rejects.toThrow(/Tests failed/)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('throws MergeError instances so callers can count merge failures', async () => {
    const taskId = '20260808_000000_007_user-error-type'
    await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light' }))
      .rejects.toBeInstanceOf(MergeError)
  })
})

describe('selectChecks', () => {
  it('selects suites from the touched paths', () => {
    expect(selectChecks(['src/frontend/src/App.tsx'])).toMatchObject({ frontend: true, backend: false })
    expect(selectChecks(['src/backend/pom.xml'])).toMatchObject({ backend: true, frontend: false })
    expect(selectChecks(['orchestration/ts/src/cli.ts'])).toMatchObject({ orchestration: true })
    expect(selectChecks(['docs/index.html'])).toMatchObject({
      frontend: false, backend: false, orchestration: false, i18n: false,
    })
  })

  it('runs the i18n check for either side of the translation contract', () => {
    expect(selectChecks(['src/frontend/src/i18n/ja.json']).i18n).toBe(true)
    expect(selectChecks(['src/backend/src/main/resources/messages.properties']).i18n).toBe(true)
    expect(selectChecks(['src/backend/src/main/java/App.java']).i18n).toBe(false)
  })
})
