import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { operatingSystem, type OperatingSystem } from '../src/adapters/os.ts'
import { createOperatingSystem as createPosixOperatingSystem } from '../src/adapters/os-posix.ts'
import { createOperatingSystem as createWindowsOperatingSystem } from '../src/adapters/os-windows.ts'
import {
  MergeError, mergeRemoteTask, mergeTask, removeMergedWorktree, removeTemporaryWorktree,
} from '../src/merge.ts'
import { branchName, orchPaths, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { stubProject } from './stubProject.ts'

let repoRoot: string
let paths: OrchPaths

const installProject: ProjectAdapter = {
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

const noCheckProject: ProjectAdapter = {
  ...stubProject,
  name: 'no-check',
  mergeChecks: () => [],
  cycleSuite: () => [],
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function expectNoTemporaryWorktree(prefix: '.merge-' | '.adopt-'): void {
  expect(readdirSync(paths.worktreesDir).filter((name) => name.startsWith(prefix))).toEqual([])
  expect(git(repoRoot, ['worktree', 'list', '--porcelain'])).not.toContain(prefix)
}

function repositoryState(): { head: string; status: string; worktrees: string } {
  return {
    head: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    status: git(repoRoot, ['status', '--porcelain']),
    worktrees: git(repoRoot, ['worktree', 'list', '--porcelain']),
  }
}

function windowsOperatingSystem(remove: (path: string, options: {
  force: true
  maxRetries?: 3
  recursive: true
}) => void): OperatingSystem {
  return createWindowsOperatingSystem({
    spawn: () => {}, listProcesses: () => [], probeProcess: () => {}, remove,
    now: Date.now, sleep: () => {},
  })
}

function posixOperatingSystem(remove: (path: string, options: {
  force: true
  recursive: true
}) => void): OperatingSystem {
  return createPosixOperatingSystem({
    signalProcessGroup: () => {}, probeProcess: () => {}, remove,
    now: Date.now, sleep: () => {}, groupHasRunningMember: () => undefined,
  })
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
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('removeMergedWorktree', () => {
  it('uses the Windows UNC namespace for a UNC worktree fallback', () => {
    const worktree = '\\\\server\\share\\orchestration\\worktrees\\task'
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Removal failed')
      return ''
    })

    removeMergedWorktree(paths, worktree, vi.fn(), {
      os: windowsOperatingSystem(remove), git: gitRuntime,
    })

    expect(remove).toHaveBeenCalledWith(
      '\\\\?\\UNC\\server\\share\\orchestration\\worktrees\\task',
      { recursive: true, force: true, maxRetries: 3 },
    )
  })

  it('uses the Windows long-path fallback and prunes after git removal fails', () => {
    const worktree = worktreeDir(paths, '20260809_102500_100_auto-long-path')
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw Object.assign(new Error('git command failed'), {
          stderr: 'error: failed to delete: Filename too long\n',
        })
      }
      return ''
    })
    const log = vi.fn()

    removeMergedWorktree(paths, worktree, log, {
      os: windowsOperatingSystem(remove), git: gitRuntime,
    })

    expect(remove).toHaveBeenCalledWith(
      `\\\\?\\${worktree.replaceAll('/', '\\')}`,
      { recursive: true, force: true, maxRetries: 3 },
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(
      `Worktree removal needed the Windows long-path fallback: ${worktree} (error: failed to delete: Filename too long)`,
    )
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('WARN:'))
  })

  it('prunes after direct removal succeeds on non-Windows platforms', () => {
    const worktree = worktreeDir(paths, '20260809_102500_100_auto-stale-registration')
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Removal failed')
      return ''
    })
    const log = vi.fn()

    removeMergedWorktree(paths, worktree, log, {
      os: posixOperatingSystem(remove), git: gitRuntime,
    })

    expect(remove).toHaveBeenCalledWith(worktree, { recursive: true, force: true })
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
    expect(log).toHaveBeenCalledWith(
      `Worktree removal needed the direct-removal fallback: ${worktree} (Removal failed)`,
    )
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('WARN:'))
  })

  it('keeps the existing warning when the Windows fallback also fails', () => {
    const worktree = worktreeDir(paths, '20260809_102500_100_auto-long-path')
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw Object.assign(new Error('git command failed'), {
          stderr: 'error: failed to delete: Filename too long\n',
        })
      }
      return ''
    })
    const log = vi.fn()

    removeMergedWorktree(paths, worktree, log, {
      os: windowsOperatingSystem(() => { throw new Error('Filename too long') }),
      git: gitRuntime,
    })

    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(
      `WARN: merged, but the worktree is still there and has to go by hand: ${worktree} (error: failed to delete: Filename too long)`,
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
  })
})

describe('removeTemporaryWorktree', () => {
  it('uses the Windows long-path fallback and prunes after git removal fails', () => {
    const worktree = join(paths.worktreesDir, '.merge-long-path')
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Removal failed')
      return ''
    })

    removeTemporaryWorktree(paths, worktree, {
      os: windowsOperatingSystem(remove), git: gitRuntime,
    })

    expect(remove).toHaveBeenCalledWith(
      `\\\\?\\${worktree.replaceAll('/', '\\')}`,
      { recursive: true, force: true, maxRetries: 3 },
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
  })

  it('fails when both Git and the direct-removal fallback fail', () => {
    const worktree = join(paths.worktreesDir, '.merge-still-present')
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Git removal failed')
      return ''
    })

    expect(() => removeTemporaryWorktree(paths, worktree, {
      os: posixOperatingSystem(() => { throw new Error('Direct removal failed') }),
      git: gitRuntime,
    })).toThrow(
      `Could not remove temporary worktree ${worktree}; merge was not applied. `
      + '(git: Git removal failed; fallback: Direct removal failed)',
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(2, paths.repoRoot, ['worktree', 'prune'])
  })
})

describe('mergeTask', () => {
  it('merges a committed task, removes its worktree and branch, and records merged', async () => {
    const taskId = '20260808_000000_001_user-adds-a-file'
    const worktree = await makeCompletedTask(taskId, { commit: true })

    const mergeCommit = await mergeTask(
      paths, taskId, { taskGate: 'light', project: stubProject },
    )

    expect(mergeCommit).toBe(git(repoRoot, ['rev-parse', 'HEAD']).trim())
    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration`,
    )
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('stops and verifies a completed runner with a live PID before merging', async () => {
    const taskId = '20260808_000000_017_user-runner-finishes-output-first'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const runnerPid = runner.pid
    if (runnerPid === undefined) throw new Error('Runner did not publish a PID.')
    runner.unref()
    await writeStatus(paths, taskId, 'completed', runnerPid)

    try {
      await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })

      expect(operatingSystem.processTreeIsAlive(runnerPid)).toBe(false)
      expect(existsSync(worktree)).toBe(false)
      expect(readStatus(paths, taskId)?.status).toBe('merged')
      expect(readStatus(paths, taskId)?.pid).toBeNull()
    } finally {
      if (operatingSystem.processTreeIsAlive(runnerPid)) {
        operatingSystem.terminateProcessTree(runnerPid)
      }
    }
  })

  it('keeps completed task state when the runner cannot be verified stopped', async () => {
    const taskId = '20260808_000000_018_user-runner-resists-stop'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerPid = 12345
    await writeStatus(paths, taskId, 'completed', runnerPid)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(`Could not stop completed runner ${runnerPid}; task state was retained.`)

    expect(terminate).toHaveBeenCalledWith(runnerPid)
    expect(existsSync(worktree)).toBe(true)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).not.toBe('')
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(false)
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: runnerPid })
  })

  it('leaves linked-issue closing syntax to the forge adapter', async () => {
    const taskId = '20260808_000000_015_user-linked-issue'
    await makeCompletedTask(taskId, { commit: true })

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: stubProject,
      closesIssue: 317,
      forge: {
        issueClosingCommitMessage: (message, issueNumber) =>
          `${message} (resolves ticket ${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration (resolves ticket 317)`,
    )
  })

  it('stops on uncommitted changes and keeps the worktree', async () => {
    const taskId = '20260808_000000_002_user-forgot-commit'
    const worktree = await makeCompletedTask(taskId, { commit: true, dirty: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/uncommitted changes/)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('stops a non-inspection task that produced no commits', async () => {
    const taskId = '20260808_000000_003_user-empty-handed'
    const worktree = await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/no new commits/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('lets a scan through without commits', async () => {
    const taskId = '20260808_000000_004_scan'
    await makeCompletedTask(taskId)
    await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('refuses a task that is not completed', async () => {
    const taskId = '20260808_000000_005_user-still-going'
    await makeCompletedTask(taskId, { commit: true })
    await writeStatus(paths, taskId, 'running', process.pid)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/not 'completed'/)
  })

  it('aborts the merge when the explicit test command fails', async () => {
    const taskId = '20260808_000000_006_user-tests-fail'
    await makeCompletedTask(taskId, { commit: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject, testCmd: 'node -e "process.exit(1)"' }))
      .rejects.toThrow(/Tests failed/)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('runs checks against the task merged with intervening run-branch commits', async () => {
    const taskId = '20260808_000000_014_user-combined-check'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(repoRoot, ['add', 'run.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add newer run work'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'full',
      project: stubProject,
      testCmd: 'node -e "const fs=require(\'node:fs\'); process.exit(fs.existsSync(\'run.txt\') && fs.existsSync(\'20260808_000000_014_user-combined-check.txt\') ? 1 : 0)"',
    })).rejects.toThrow(/Tests failed/)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(false)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('aborts a conflicting merge without changing the run branch or task state', async () => {
    const taskId = '20260808_000000_016_user-conflicting-change'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, 'README.md'), '# task version\n')
    git(worktree, ['add', 'README.md'])
    git(worktree, ['commit', '-qm', 'feat: change README in task'])
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()

    writeFileSync(join(repoRoot, 'README.md'), '# run version\n')
    git(repoRoot, ['add', 'README.md'])
    git(repoRoot, ['commit', '-qm', 'feat: change README on run branch'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const runStatus = git(repoRoot, ['status', '--porcelain'])

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    })).rejects.toThrow('A merge conflict occurred. Rebase the worktree, then retry the merge.')

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe(runStatus)
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('# run version\n')
    expect(existsSync(worktree)).toBe(true)
    expect(git(worktree, ['rev-parse', 'HEAD']).trim()).toBe(taskHead)
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expectNoTemporaryWorktree('.merge-')
  })

  it('throws MergeError instances so callers can count merge failures', async () => {
    const taskId = '20260808_000000_007_user-error-type'
    await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toBeInstanceOf(MergeError)
  })

  it('installs before a merge check when its dependency path is absent', async () => {
    const taskId = '20260808_000000_008_user-needs-install'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'merge-check.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })

    const output = readFileSync(outputFile, 'utf8')
    const outputLines = output.split(/\r?\n/)
    expect(outputLines.filter((line) => line === 'install ran')).toHaveLength(1)
    expect(outputLines.indexOf('install ran')).toBeLessThan(outputLines.indexOf('check ran'))
    expect(outputLines).toContain('check warning')
  })

  it('rejects a check that passed on dependencies it does not have', async () => {
    const taskId = '20260808_000000_013_user-declares-uninstalled-dependency'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a dependency nobody installed'])
    const outputFile = join(repoRoot, 'merge-check.log')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })).rejects.toThrow(/Tests failed/)

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain('passed on dependencies it does not have')
    expect(output).toContain('fixture-dependency')
  })

  it('does not apply Node dependency isolation to adapters that did not opt in', async () => {
    const taskId = '20260808_000000_018_user-uses-another-package-manager'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'virtual-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a virtual dependency'])
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'virtual-dependencies',
      mergeChecks: () => [{ label: 'Non-Node gate', cwd: '', command: 'node -e ""' }],
    }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project,
    })).resolves.toBe(git(repoRoot, ['rev-parse', 'HEAD']).trim())
  })

  it('accepts a check that installs its own dependencies as its first step', async () => {
    const taskId = '20260808_000000_014_user-installs-inside-the-check'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a dependency the check installs'])
    // The core's own gate is `npm ci && tsc && npm test` in one command: nothing is
    // installed when the check starts, and everything is by the time it ends.
    const installingProject: ProjectAdapter = {
      ...stubProject,
      name: 'installs-inside-check',
      mergeChecks: () => [{
        label: 'Fixture gate',
        cwd: '',
        command: 'node -e "const {mkdirSync,writeFileSync}=require(\'fs\');'
          + "mkdirSync('node_modules/fixture-dependency',{recursive:true});"
          + "writeFileSync('node_modules/.package-lock.json','{}')\"",
      }],
    }

    await mergeTask(paths, taskId, { taskGate: 'light', project: installingProject })

    expect(git(repoRoot, ['log', '-1', '--pretty=%s'])).toContain(taskId)
  })

  it('skips installation when the merge check dependency path is present', async () => {
    const taskId = '20260808_000000_009_user-has-dependency'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'dependency-ready'), 'ready\n')
    git(worktree, ['add', 'dependency-ready'])
    git(worktree, ['commit', '-qm', 'test: add dependency fixture'])
    const outputFile = join(repoRoot, 'merge-check.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).not.toContain('install ran')
    expect(output.split(/\r?\n/).filter((line) => line === 'check ran')).toHaveLength(1)
  })

  it('installs orchestration dependencies once when the merge changes package.json', async () => {
    const taskId = '20260808_000000_010_user-adds-orchestration-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package.json'), '{"dependencies":{}}\n')
    git(worktree, ['add', 'orchestration/ts/package.json'])
    git(worktree, ['commit', '-qm', 'feat: add orchestration dependency'])
    const statusDuringInstall: Array<string | undefined> = []
    const install = vi.fn(() => {
      statusDuringInstall.push(readStatus(paths, taskId)?.status)
    })
    const event = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
      onOrchestrationDepsEvent: event,
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(join(repoRoot, 'orchestration', 'ts'))
    expect(statusDuringInstall).toEqual(['merged'])
    expect(event).toHaveBeenCalledWith(
      'Installed', 'after 010_user',
    )
  })

  it('installs orchestration dependencies when the package is at the repository root', async () => {
    const taskId = '20260808_000000_013_user-updates-root-dependency'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, 'package.json'), '{"dependencies":{}}\n')
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'fix: update root dependency'])
    const install = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: repoRoot },
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(repoRoot)
  })

  it('does not install orchestration dependencies when the merge leaves manifests unchanged', async () => {
    const taskId = '20260808_000000_011_user-changes-source'
    await makeCompletedTask(taskId, { commit: true })
    const install = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
    })

    expect(install).not.toHaveBeenCalled()
  })

  it('warns without failing the merge when orchestration dependency installation fails', async () => {
    const taskId = '20260808_000000_012_user-adds-broken-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package-lock.json'), '{}\n')
    git(worktree, ['add', 'orchestration/ts/package-lock.json'])
    git(worktree, ['commit', '-qm', 'feat: update orchestration lockfile'])
    const event = vi.fn()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: {
        install: () => { throw new Error('registry unavailable') },
        packageRoot: join(repoRoot, 'orchestration', 'ts'),
      },
      onOrchestrationDepsEvent: event,
    })).resolves.toBe(git(repoRoot, ['rev-parse', 'HEAD']).trim())

    expect(event).toHaveBeenCalledWith(
      'WARN', expect.stringContaining('registry unavailable'),
    )
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })
})

describe('mergeRemoteTask', () => {
  it('rejects a malformed task branch without changing HEAD or worktree state', async () => {
    const before = repositoryState()

    await expect(mergeRemoteTask(
      paths,
      222,
      'origin',
      'task/../outside',
      before.head,
      {
        taskGate: 'light',
        project: noCheckProject,
        forge: { issueClosingCommitMessage: (message) => message },
      },
    )).rejects.toThrow('Issue #222 reported an invalid task branch: task/../outside')

    expect(repositoryState()).toEqual(before)
  })

  it('rejects a malformed reported head without changing HEAD or worktree state', async () => {
    const before = repositoryState()

    await expect(mergeRemoteTask(
      paths,
      223,
      'origin',
      'task/remote-malformed-head',
      'not-a-commit',
      {
        taskGate: 'light',
        project: noCheckProject,
        forge: { issueClosingCommitMessage: (message) => message },
      },
    )).rejects.toThrow('Issue #223 reported an invalid head commit: not-a-commit')

    expect(repositoryState()).toEqual(before)
  })

  it('rejects a mismatched reported head without changing HEAD or worktree state', async () => {
    const branch = 'task/remote-mismatched-head'
    const reportedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const fetchedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, fetchedHead])
    git(repoRoot, ['branch', '-D', branch])
    const before = repositoryState()

    await expect(mergeRemoteTask(paths, 224, 'origin', branch, reportedHead, {
      taskGate: 'light',
      project: noCheckProject,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(
      `Remote branch ${branch} is at ${fetchedHead}, not the reported ${reportedHead}.`,
    )

    expect(repositoryState()).toEqual(before)
  })

  it('rejects an already-merged branch without changing HEAD or worktree state', async () => {
    const branch = 'task/remote-already-merged'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['merge', '--ff-only', branch])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    git(repoRoot, ['branch', '-D', branch])
    const before = repositoryState()

    await expect(mergeRemoteTask(paths, 225, 'origin', branch, expectedHead, {
      taskGate: 'light',
      project: noCheckProject,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(`${branch} has no new commits relative to main.`)

    expect(repositoryState()).toEqual(before)
  })

  it('leaves issue-closing syntax to the forge adapter', async () => {
    const branch = 'task/remote-runner-neutral-message'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/shared/${branch}`, expectedHead])

    await mergeRemoteTask(paths, 219, 'shared', branch, expectedHead, {
      taskGate: 'light', project: noCheckProject,
      forge: {
        issueClosingCommitMessage: (message, issueNumber) =>
          `${message} (resolves ticket ${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      'Merge remote-runner-neutral-message via orchestration (resolves ticket 219)',
    )
  })

  it('removes the checked worktree before applying the remote merge', async () => {
    const branch = 'task/remote-clean-before-merge'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const onMerged = vi.fn(() => expectNoTemporaryWorktree('.adopt-'))

    await mergeRemoteTask(paths, 226, 'origin', branch, expectedHead, {
      taskGate: 'light', project: noCheckProject, onMerged,
      forge: { issueClosingCommitMessage: (message) => message },
    })

    expect(onMerged).toHaveBeenCalledOnce()
  })

  it('runs checks against the worker branch merged with the current branch', async () => {
    const branch = 'task/remote-combined-check'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(repoRoot, ['add', 'run.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add newer run work'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeRemoteTask(paths, 220, 'origin', branch, expectedHead, {
      taskGate: 'light',
      project: stubProject,
      forge: { issueClosingCommitMessage: (message) => message },
      testCmd: 'node -e "const fs=require(\'node:fs\'); process.exit(fs.existsSync(\'run.txt\') && fs.existsSync(\'task.txt\') ? 1 : 0)"',
    })).rejects.toThrow(/Tests failed/)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(join(repoRoot, 'run.txt'))).toBe(true)
    expect(existsSync(join(repoRoot, 'task.txt'))).toBe(false)
  })

  it('aborts a conflicting adoption without changing the run branch or remote state', async () => {
    const branch = 'task/remote-conflicting-change'
    const remoteRef = `refs/remotes/origin/${branch}`
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'README.md'), '# remote version\n')
    git(repoRoot, ['add', 'README.md'])
    git(repoRoot, ['commit', '-qm', 'feat: change README remotely'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', remoteRef, expectedHead])
    git(repoRoot, ['branch', '-D', branch])

    writeFileSync(join(repoRoot, 'README.md'), '# run version\n')
    git(repoRoot, ['add', 'README.md'])
    git(repoRoot, ['commit', '-qm', 'feat: change README on run branch'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const runStatus = git(repoRoot, ['status', '--porcelain'])

    await expect(mergeRemoteTask(paths, 221, 'origin', branch, expectedHead, {
      taskGate: 'light',
      project: noCheckProject,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(`A merge conflict occurred while adopting ${branch}.`)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe(runStatus)
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('# run version\n')
    expect(git(repoRoot, ['rev-parse', remoteRef]).trim()).toBe(expectedHead)
    expect(git(repoRoot, ['show', `${remoteRef}:README.md`])).toBe('# remote version\n')
    expectNoTemporaryWorktree('.adopt-')
  })
})
