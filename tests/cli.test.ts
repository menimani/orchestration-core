import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordIssueForTask } from '../src/issueQueue.ts'
import { branchName, orchPaths, worktreeDir } from '../src/paths.ts'
import { writeStatus } from '../src/status.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.ts')

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-cli-'))
  const init = spawnSync('git', ['init'], { cwd: repoRoot, windowsHide: true })
  expect(init.status).toBe(0)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function daemonFile(name: string): string {
  return join(repoRoot, 'orchestration', 'queue', name)
}

function git(args: string[], cwd = repoRoot): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

describe('command registry', () => {
  it('lists deploy as an available command', () => {
    const result = spawnSync(process.execPath, [CLI, 'unknown'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('deploy')
    expect(result.stderr).toContain('ci-wait')
  })

  it('refuses to start a worker without a base ref', () => {
    const result = spawnSync(process.execPath, [CLI, 'worker'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage: worker <base-ref>')
  })
})

describe('manual merge', () => {
  it('builds merge options that close the task-linked issue', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20260808_000000_001_user-linked-merge'
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(join(worktree, 'work.txt'), 'done\n')
    git(['add', '-A'], worktree)
    git(['commit', '-qm', 'fix: complete linked task'], worktree)
    await writeStatus(paths, taskId, 'completed')
    recordIssueForTask(paths, taskId, 197)
    const runBranch = git(['branch', '--show-current']).trim()

    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(0)
    expect(git(['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via Codex (closes #197)`,
    )
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    expect(JSON.parse(readFileSync(
      join(paths.queueDir, 'issue-promotion', '197.json'), 'utf8',
    ))).toEqual({
      taskId,
      issueNumber: 197,
      mergeCommit,
      runBranch,
    })
  })
})

describe('loop daemon ownership', () => {
  it('removes the PID and issue marker after a startup failure', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop'], {
      cwd: repoRoot,
      env: { ...process.env, FORGE: 'missing', ISSUE_QUEUE_ENABLED: 'true' },
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown FORGE 'missing'")
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('issue-mode'))).toBe(false)
  })

  it('removes the PID and issue marker after a normal shutdown', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
      },
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('issue-mode'))).toBe(false)
  })
})
