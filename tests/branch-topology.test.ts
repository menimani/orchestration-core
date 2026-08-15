import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  absorbDefaultBranch, prepareBranchTopology, prepareIntegrationWorktree,
} from '../src/branchTopology.ts'
import { loadConfig } from '../src/config.ts'
import { createLoop } from '../src/loop.ts'
import { mergeTask } from '../src/merge.ts'
import {
  branchName, orchPaths, worktreeDir, type OrchPaths,
} from '../src/paths.ts'
import { startTask } from '../src/start.ts'
import { writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { makeFakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { stubProject } from './stubProject.ts'

let repoRoot: string
let remoteRoot: string
let paths: OrchPaths

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content)
  git(cwd, ['add', file])
  git(cwd, ['commit', '-qm', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}

function pushRemoteDefaultChange(file: string, content: string): string {
  const clone = mkdtempSync(join(tmpdir(), 'orch-topology-clone-'))
  try {
    git(clone, ['clone', '-q', remoteRoot, '.'])
    git(clone, ['config', 'user.email', 'remote@example.test'])
    git(clone, ['config', 'user.name', 'Remote Test'])
    const head = commit(clone, file, content, 'feat: advance default branch')
    git(clone, ['push', '-q', 'origin', 'main'])
    return head
  } finally {
    rmSync(clone, { recursive: true, force: true })
  }
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-topology-'))
  remoteRoot = join(repoRoot, 'origin.git')
  git(repoRoot, ['init', '-q', '-b', 'main'])
  git(repoRoot, ['config', 'user.email', 'daemon@example.test'])
  git(repoRoot, ['config', 'user.name', 'Daemon Test'])
  writeFileSync(join(repoRoot, '.gitignore'), [
    'orchestration/queue/',
    'orchestration/logs/',
    'orchestration/status/',
    'orchestration/tasks/',
    'orchestration/worktrees/',
    'origin.git/',
  ].join('\n'))
  writeFileSync(join(repoRoot, 'tracked.txt'), 'initial\n')
  git(repoRoot, ['add', '-A'])
  git(repoRoot, ['commit', '-qm', 'chore: initial commit'])
  git(repoRoot, ['init', '--bare', '-q', remoteRoot])
  git(repoRoot, ['remote', 'add', 'origin', remoteRoot])
  git(repoRoot, ['push', '-q', '-u', 'origin', 'main'])
  git(remoteRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  git(repoRoot, ['switch', '-q', '-c', 'daemon/run'])
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('integration branch topology', () => {
  it('keeps the direct single-worktree layout by default', () => {
    const topology = prepareBranchTopology(paths, '')

    expect(topology.paths).toBe(paths)
    expect(existsSync(join(paths.worktreesDir, '.integration'))).toBe(false)
  })

  it('cuts tasks from integration, merges them back there, and never moves the daemon', async () => {
    const daemonPackageRoot = join(repoRoot, 'orchestration', 'ts')
    mkdirSync(daemonPackageRoot, { recursive: true })
    writeFileSync(join(daemonPackageRoot, 'package.json'), '{"private":true}\n')
    git(repoRoot, ['add', 'orchestration/ts/package.json'])
    git(repoRoot, ['commit', '-qm', 'chore: add orchestration package'])
    const daemonHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const topology = prepareBranchTopology(paths, 'integration/run', daemonPackageRoot)
    const integrationRoot = topology.paths.repoRoot
    const integrationBase = commit(
      integrationRoot, 'integration.txt', 'available to tasks\n', 'feat: integration input',
    )
    const taskId = '20260814_120000_001_auto-topology'
    writeFileSync(specFile(paths, taskId), '# topology task\n')

    await startTask(topology.paths, {
      sharedSkills: fakeRunnerSharedSkills,
      start: async () => process.pid,
    }, taskId, { effort: 'medium' })

    const taskRoot = worktreeDir(paths, taskId)
    expect(readFileSync(join(taskRoot, 'integration.txt'), 'utf8').replaceAll('\r', ''))
      .toBe('available to tasks\n')
    expect(git(taskRoot, ['merge-base', branchName(taskId), integrationBase])).toBe(integrationBase)
    commit(taskRoot, 'task.txt', 'task result\n', 'feat: task result')
    commit(
      taskRoot, 'orchestration/ts/package.json', '{"private":true,"dependencies":{}}\n',
      'chore: update orchestration package',
    )
    const taskHead = git(taskRoot, ['rev-parse', 'HEAD'])
    await writeStatus(paths, taskId, 'completed')
    const install = vi.fn()

    await mergeTask(topology.paths, taskId, {
      taskGate: 'light',
      project: stubProject,
      outputFile: join(paths.logsDir, 'topology.merge.log'),
      orchestrationDepsRuntime: { install, packageRoot: topology.packageRoot },
    })

    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(daemonHead)
    expect(git(repoRoot, ['merge-base', '--is-ancestor', taskHead, 'integration/run']))
      .toBe('')
    expect(git(integrationRoot, ['branch', '--show-current'])).toBe('integration/run')
    expect(git(integrationRoot, ['rev-parse', 'HEAD'])).not.toBe(integrationBase)
    expect(topology.packageRoot).toBe(join(integrationRoot, 'orchestration', 'ts'))
    expect(install).toHaveBeenCalledWith(topology.packageRoot)
  })

  it('uses the integration branch for PR updates and final promotion', async () => {
    const topology = prepareBranchTopology(paths, 'integration/run')
    const forge = makeFakeForge()
    const updatePr = vi.spyOn(forge, 'updatePr')
    const markPrReady = vi.spyOn(forge, 'markPrReady').mockImplementation(async () => {
      forge.prStatusValue = { ...forge.prStatusValue, isDraft: false }
    })
    const markers: string[] = []
    const loop = createLoop({
      paths: topology.paths,
      config: { ...loadConfig({}), integrationBranch: 'integration/run' },
      forge,
      runner: { sharedSkills: fakeRunnerSharedSkills, start: async () => process.pid },
      project: stubProject,
      log: vi.fn(),
      marker: (line) => markers.push(line),
      now: () => new Date('2026-08-14T12:00:00Z'),
    })

    expect(await loop.postLoopPr()).toBe(true)

    expect(updatePr).toHaveBeenCalledWith('integration/run', expect.any(Object))
    expect(markPrReady).toHaveBeenCalledWith('integration/run')
    expect(forge.prStatusRefs).toEqual([
      { kind: 'branch', value: 'integration/run' },
      { kind: 'branch', value: 'integration/run' },
      { kind: 'branch', value: 'integration/run' },
    ])
    expect(markers).toContain('LOOP_DONE: https://example.test/pull/1')
  })

  it('refreshes and prepares integration before starting the next scan cycle', async () => {
    const topology = prepareBranchTopology(paths, 'integration/run')
    pushRemoteDefaultChange('default-change.txt', 'default work\n')
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'scan-template.md'), '{{SCAN_SCOPE}}\n')
    const lifecycle: string[] = []
    const loop = createLoop({
      paths: topology.paths,
      config: {
        ...loadConfig({}),
        integrationBranch: 'integration/run',
        scanParallel: 1,
        autoPr: false,
        reviewEnabled: false,
      },
      forge: makeFakeForge(),
      runner: {
        sharedSkills: fakeRunnerSharedSkills,
        start: async () => {
          lifecycle.push('start scan')
          return process.pid
        },
      },
      project: stubProject,
      log: vi.fn(),
      now: () => new Date('2026-08-14T12:00:00Z'),
      updateCoreBeforeCycle: async () => {
        lifecycle.push('update core')
        return 'continue'
      },
      prepareIntegrationWorktree: () => {
        expect(readFileSync(join(topology.paths.repoRoot, 'default-change.txt'), 'utf8')
          .replaceAll('\r', '')).toBe('default work\n')
        lifecycle.push('prepare integration')
      },
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(lifecycle).toEqual(['update core', 'prepare integration', 'start scan'])
    expect(readFileSync(join(topology.paths.queueDir, 'scan-count.txt'), 'utf8')).toBe('1\n')
  })

  it('rechecks the adapter after absorbing the default branch', async () => {
    const topology = prepareBranchTopology(paths, 'integration/run')
    pushRemoteDefaultChange('adapter-change.txt', 'new adapter source\n')
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'scan-template.md'), '{{SCAN_SCOPE}}\n')
    const prepareIntegration = vi.fn()
    const start = vi.fn(async () => process.pid)
    const adapterChanged = vi.fn(() =>
      existsSync(join(topology.paths.repoRoot, 'adapter-change.txt')))
    const loop = createLoop({
      paths: topology.paths,
      config: {
        ...loadConfig({}),
        integrationBranch: 'integration/run',
        scanParallel: 1,
        autoPr: false,
        reviewEnabled: false,
      },
      forge: makeFakeForge(),
      runner: { sharedSkills: fakeRunnerSharedSkills, start },
      project: stubProject,
      projectAdapterChanged: adapterChanged,
      log: vi.fn(),
      now: () => new Date('2026-08-14T12:00:00Z'),
      updateCoreBeforeCycle: async () => 'continue',
      prepareIntegrationWorktree: prepareIntegration,
    })

    expect(await loop.triggerScanIfIdle()).toBe('restart')

    expect(loop.restartSubject()).toBe('adapter')
    expect(adapterChanged).toHaveBeenCalledTimes(2)
    expect(prepareIntegration).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(existsSync(join(topology.paths.queueDir, 'scan-count.txt'))).toBe(false)
  })

  it.each([
    {
      state: 'dirty',
      changeCheckout: () => {
        writeFileSync(join(repoRoot, 'unexpected-change.txt'), 'dirty daemon checkout\n')
        return 'daemon checkout daemon/run has uncommitted changes'
      },
    },
    {
      state: 'switched branch',
      changeCheckout: () => {
        git(repoRoot, ['switch', '-q', '-c', 'unexpected/branch'])
        return 'daemon checkout unexpected/branch does not match fixed branch daemon/run'
      },
    },
    {
      state: 'moved HEAD',
      changeCheckout: (daemonHead: string) => {
        const currentHead = commit(
          repoRoot, 'daemon-change.txt', 'moved\n', 'feat: move daemon branch',
        )
        return `daemon branch daemon/run moved from fixed commit ${daemonHead.slice(0, 8)} `
          + `to ${currentHead.slice(0, 8)}`
      },
    },
  ])('stops before cycle work when the fixed daemon checkout is $state', async ({
    changeCheckout,
  }) => {
    const topology = prepareBranchTopology(paths, 'integration/run')
    const updateCoreBeforeCycle = vi.fn(async () => 'continue' as const)
    const prepareIntegration = vi.fn()
    const start = vi.fn(async () => process.pid)
    const events: string[] = []
    const loop = createLoop({
      paths: topology.paths,
      config: {
        ...loadConfig({}),
        integrationBranch: 'integration/run',
        scanParallel: 1,
        autoPr: false,
        reviewEnabled: false,
      },
      forge: makeFakeForge(),
      runner: { sharedSkills: fakeRunnerSharedSkills, start },
      project: stubProject,
      log: (line) => events.push(line),
      now: () => new Date('2026-08-14T12:00:00Z'),
      branchGuard: topology.validateDaemonCheckout,
      updateCoreBeforeCycle,
      prepareIntegrationWorktree: prepareIntegration,
    })
    loop.initializeSessionStateForBranch()
    const problem = changeCheckout(topology.daemonHead)

    expect(await loop.poll()).toBe('stopped')

    expect(events).toContain(`ERROR ${problem}`)
    expect(updateCoreBeforeCycle).not.toHaveBeenCalled()
    expect(prepareIntegration).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(existsSync(join(topology.paths.queueDir, 'scan-count.txt'))).toBe(false)
  })

  it('keeps the daemon commit fixed across a resume while retaining integration work', () => {
    const first = prepareBranchTopology(paths, 'integration/run')
    commit(first.paths.repoRoot, 'during-stop.txt', 'kept\n', 'fix: work during stop')

    const resumed = prepareBranchTopology(paths, 'integration/run')

    expect(existsSync(join(resumed.paths.repoRoot, 'during-stop.txt'))).toBe(true)
    expect(resumed.daemonHead).toBe(first.daemonHead)
    commit(repoRoot, 'daemon-change.txt', 'moved\n', 'feat: move daemon branch')
    expect(() => prepareBranchTopology(paths, 'integration/run'))
      .toThrow('The resumed run is fixed')
  })

  it('refuses direct mode when resuming an integration run', () => {
    prepareBranchTopology(paths, 'integration/run')

    expect(() => prepareBranchTopology(paths, ''))
      .toThrow('This run uses integration branch integration/run; refusing direct mode.')
  })

  it('installs integration dependencies through adapter-owned setup', () => {
    const topology = prepareBranchTopology(paths, 'integration/run')
    const reported: string[] = []

    prepareIntegrationWorktree(topology.paths, [{
      label: 'Fixture dependencies',
      cwd: '',
      command: 'node -e "require(\'node:fs\').writeFileSync(\'deps-ready\', \'ready\\n\')"',
    }], (line) => reported.push(line))

    expect(readFileSync(join(topology.paths.repoRoot, 'deps-ready'), 'utf8')).toBe('ready\n')
    expect(reported).toEqual(['Preparing integration worktree: Fixture dependencies'])
  })

  it('absorbs the remote default branch into integration only', () => {
    const daemonHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const topology = prepareBranchTopology(paths, 'integration/run')
    const remoteHead = pushRemoteDefaultChange('default-change.txt', 'default work\n')
    const events: string[] = []

    absorbDefaultBranch(topology.paths,
      (name, subject, detail = '') => events.push(`${name} ${subject} ${detail}`.trim()))

    expect(git(topology.paths.repoRoot, [
      'merge-base', '--is-ancestor', remoteHead, 'HEAD',
    ])).toBe('')
    expect(readFileSync(join(topology.paths.repoRoot, 'default-change.txt'), 'utf8')
      .replaceAll('\r', ''))
      .toBe('default work\n')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(daemonHead)
    expect(existsSync(join(repoRoot, 'default-change.txt'))).toBe(false)
    expect(events).toContain('Updated default branch origin/main')
  })

  it('warns and leaves a conflicting default-branch merge for a person', () => {
    const topology = prepareBranchTopology(paths, 'integration/run')
    const integrationHead = commit(
      topology.paths.repoRoot, 'tracked.txt', 'integration version\n',
      'feat: integration version',
    )
    pushRemoteDefaultChange('tracked.txt', 'default version\n')
    const events: string[] = []

    absorbDefaultBranch(topology.paths,
      (name, subject, detail = '') => events.push(`${name} ${subject} ${detail}`.trim()))

    expect(git(topology.paths.repoRoot, ['rev-parse', 'HEAD'])).toBe(integrationHead)
    expect(git(topology.paths.repoRoot, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(join(topology.paths.repoRoot, 'tracked.txt'), 'utf8')
      .replaceAll('\r', '')).toBe('integration version\n')
    expect(events.some((line) => line.startsWith(
      'WARN default branch merge conflicted; continuing:',
    ))).toBe(true)
  })
})
