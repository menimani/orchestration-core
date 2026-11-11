import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Runner } from '../src/adapters/runner.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import { loadConfig } from '../src/config.ts'
import { createLoop } from '../src/loop.ts'
import { branchName, orchPaths, statusFile, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { recordTaskProcess } from '../src/processRegistry.ts'
import { makeFakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { buildRepositoryTemplate, type RepositoryTemplate } from './repositoryTemplate.ts'
import { stubProject } from './stubProject.ts'

// A poll reads every task's status several times, but only the refresh of a running task
// needs its process. On Windows each identity probe launches a process, so the other
// reads must answer from the durable record alone.

const RUNNER_PID = process.pid + 1_000_000
// The poll's clock. The runners started an hour before it, well inside the task deadline.
const POLL_TIME = new Date(2026, 7, 9, 12, 0, 0)
const RUNNER_STARTED_AT = new Date(POLL_TIME.getTime() - 3_600_000).toISOString()

let repoRoot: string
let paths: OrchPaths
let logged: string[]
let template: RepositoryTemplate<void> | undefined

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

afterAll(() => {
  template?.dispose()
})

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-loop-status-probes-'))
  template ??= buildRepositoryTemplate((root) => {
    git(['init', '--initial-branch=main'], root)
    git(['config', 'user.email', 'loop-test@example.test'], root)
    git(['config', 'user.name', 'Loop Test'], root)
    writeFileSync(join(root, 'tracked.txt'), 'initial\n')
    git(['add', 'tracked.txt'], root)
    git(['commit', '-m', 'initial'], root)
  })
  template.copyTo(repoRoot)
  paths = orchPaths(repoRoot)
  logged = []
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

function writeRunningStatus(taskId: string): void {
  writeFileSync(statusFile(paths, taskId), JSON.stringify({
    task_id: taskId,
    status: 'running',
    started_at: RUNNER_STARTED_AT,
    updated_at: RUNNER_STARTED_AT,
    worktree: worktreeDir(paths, taskId),
    branch: branchName(taskId),
  }))
  recordTaskProcess(paths, taskId, RUNNER_PID)
}

describe('poll status reads', () => {
  it('probes each running process once per poll', async () => {
    // The registered runner is a PID no test process owns, answered as a live process
    // whose start identity still matches the one recorded at launch.
    const probe = vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockImplementation((pid) => (pid === RUNNER_PID ? 'runner-start' : undefined))
    vi.spyOn(operatingSystem, 'processIsAlive').mockImplementation((pid) => pid === RUNNER_PID)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockImplementation((pid) => pid === RUNNER_PID)
    writeRunningStatus('20260809_000000_001_scan')
    writeRunningStatus('20260809_000001_002_auto-first')
    writeRunningStatus('20260809_000002_003_auto-second')

    const runner: Runner = {
      sharedSkills: fakeRunnerSharedSkills,
      start: async () => process.pid,
    }
    const loop = createLoop({
      paths,
      config: { ...loadConfig({}), scanEnabled: false },
      forge: makeFakeForge(),
      runner,
      project: stubProject,
      log: (line) => logged.push(line),
      now: () => POLL_TIME,
    })
    loop.initializeSessionStateForBranch()
    // Startup classifies every task once by its process; only the poll's reads count.
    probe.mockClear()

    expect(await loop.poll(), logged.join('\n')).toBe('continue')
    expect(logged).toContain('Running Status      Scan=1  Task=2  Queue=0')
    // The daemon's own identity is probed for its lock ownership; it is not a runner.
    expect(probe.mock.calls.filter(([pid]) => pid === RUNNER_PID)).toHaveLength(3)
  })
})
