import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  absolutePackageScriptCommand, branchName, orchPaths, statusFile, worktreeDir,
} from '../src/paths.ts'
import { recordTaskProcess } from '../src/processRegistry.ts'
import { processMarker, processMarkerText } from '../src/processMarker.ts'
import { writeStatus } from '../src/status.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import {
  childCompletion, CLI, CLI_TIMEOUT_MS, CORE_ENV, daemonFile, extraRoots, git, HERE, INHERITED_ENV, pidIsAlive,
  repoRoot, testProcesses, waitUntil,
} from './cliHarness.ts'

describe('loop daemon ownership', () => {
  it('keeps a cross-repository daemon and its reported commands bound to the target', async () => {
    const callerRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'orch-cli-caller-')))
    extraRoots.push(callerRoot)
    mkdirSync(join(repoRoot, 'orchestration'))
    writeFileSync(join(repoRoot, 'relative-runner.mjs'), [
      "import { join } from 'node:path'",
      'export default {',
      '  sharedSkills: {',
      "    destinationRoot: (root) => join(root, '.test-runner', 'skills'),",
      '    renderFile: (contents) => contents,',
      '  },',
      '  start: async () => process.pid,',
      '}',
      '',
    ].join('\n'))

    const result = spawnSync(
      process.execPath,
      [CLI, 'loop', '--approve-mode', 'local', '--daemon', '--repo', repoRoot],
      {
        cwd: callerRoot,
        env: {
          ...CORE_ENV,
          AUTO_PR: 'false',
          ISSUE_QUEUE_ENABLED: 'false',
          MAX_SCAN_CYCLES: '0',
          RUNNER: './relative-runner.mjs',
          SCAN_ENABLED: 'true',
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Started the loop in the background')
    expect(result.stdout).toContain(
      `Check: ${absolutePackageScriptCommand(repoRoot, 'loop-status')}`,
    )
    expect(result.stdout).toContain(`Stop: ${absolutePackageScriptCommand(repoRoot, 'stop')}`)
    const match = /Started the loop in the background \(PID=(\d+)\)/.exec(result.stdout)
    expect(match).not.toBeNull()
    const daemonPid = Number(match?.[1])
    testProcesses.trackPid(daemonPid, { tree: true })
    await waitUntil(() => !pidIsAlive(daemonPid), 'cross-repository daemon did not stop')
  })

  it('refuses a non-interactive start without an approved mode before side effects', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, FORGE: 'missing', ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('queue mode: local')
    expect(result.stderr).toContain('pass --approve-mode local')
    expect(existsSync(join(repoRoot, 'orchestration', 'queue'))).toBe(false)
    expect(existsSync(join(repoRoot, 'orchestration', 'worktrees'))).toBe(false)
  })

  it('refuses a non-interactive start when the approved mode differs', () => {
    const result = spawnSync(
      process.execPath,
      [CLI, 'loop', '--approve-mode', 'local'],
      {
        cwd: repoRoot,
        env: { ...CORE_ENV, FORGE: 'missing', ISSUE_QUEUE_ENABLED: 'true' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("approved queue mode 'local'")
    expect(result.stderr).toContain("resolved queue mode 'issue'")
    expect(existsSync(join(repoRoot, 'orchestration', 'queue'))).toBe(false)
    expect(existsSync(join(repoRoot, 'orchestration', 'worktrees'))).toBe(false)
  })

  it.each(['Y', 'YES', ' y', 'yes '])('refuses the non-exact TTY approval answer %j', async (answer) => {
    const close = vi.fn()
    const question = vi.fn(async () => answer)
    vi.doMock('node:readline/promises', () => ({
      createInterface: () => ({ close, question }),
    }))
    vi.doMock('../src/adapters/runner.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/adapters/runner.ts')>(),
      loadRunner: async () => ({ sharedSkills: fakeRunnerSharedSkills, start: vi.fn() }),
    }))
    vi.doMock('node:child_process', async (importOriginal) => {
      const childProcess = await importOriginal<typeof import('node:child_process')>()
      return {
        ...childProcess,
        execFileSync: (...args: Parameters<typeof execFileSync>) => {
          const [file, fileArgs] = args
          if (file === 'git' && fileArgs?.join(' ') === 'rev-parse --show-toplevel') {
            return repoRoot
          }
          return childProcess.execFileSync(...args)
        },
      }
    })
    vi.resetModules()

    const previousArgv = process.argv
    const previousExitCode = process.exitCode
    const previousEnv = { ...process.env }
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV, { ISSUE_QUEUE_ENABLED: 'false' })
      process.argv = [process.execPath, CLI, 'loop']

      await import('../src/cli.ts')

      expect(process.exitCode).toBe(1)
      expect(question).toHaveBeenCalledWith('Start the loop with this configuration? [y/N] ')
      expect(close).toHaveBeenCalledOnce()
      expect(existsSync(join(repoRoot, 'orchestration', 'queue'))).toBe(false)
    } finally {
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      if (stdinIsTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY
      else Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY)
      vi.doUnmock('node:readline/promises')
      vi.doUnmock('../src/adapters/runner.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it.each([
    ['agrees', 'local', 0],
    ['differs', 'issue', 1],
  ])('applies a TTY start\'s approved mode without prompting when it %s', async (_case, mode, exitCode) => {
    const question = vi.fn(async () => 'n')
    vi.doMock('node:readline/promises', () => ({
      createInterface: () => ({ close: vi.fn(), question }),
    }))
    vi.doMock('../src/adapters/runner.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/adapters/runner.ts')>(),
      loadRunner: async () => ({ sharedSkills: fakeRunnerSharedSkills, start: vi.fn() }),
    }))
    vi.doMock('node:child_process', async (importOriginal) => {
      const childProcess = await importOriginal<typeof import('node:child_process')>()
      return {
        ...childProcess,
        execFileSync: (...args: Parameters<typeof execFileSync>) => {
          const [file, fileArgs] = args
          if (file === 'git' && fileArgs?.join(' ') === 'rev-parse --show-toplevel') {
            return repoRoot
          }
          return childProcess.execFileSync(...args)
        },
      }
    })
    vi.resetModules()

    const previousArgv = process.argv
    const previousExitCode = process.exitCode
    const previousEnv = { ...process.env }
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV, {
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
      })
      process.exitCode = undefined
      process.argv = [process.execPath, CLI, 'loop', '--approve-mode', mode]

      await import('../src/cli.ts')

      expect(process.exitCode ?? 0).toBe(exitCode)
      expect(question).not.toHaveBeenCalled()
      if (exitCode === 1) {
        expect(errors).toHaveBeenCalledWith(
          "Refusing start: approved queue mode 'issue' does not match resolved queue mode 'local'.",
        )
      }
    } finally {
      errors.mockRestore()
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      if (stdinIsTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY
      else Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY)
      vi.doUnmock('node:readline/promises')
      vi.doUnmock('../src/adapters/runner.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('accepts a non-interactive start when the approved mode agrees', () => {
    const result = spawnSync(
      process.execPath,
      [CLI, 'loop', '--approve-mode', 'local'],
      {
        cwd: repoRoot,
        env: {
          ...CORE_ENV,
          AUTO_PR: 'false',
          ISSUE_QUEUE_ENABLED: 'false',
          MAX_SCAN_CYCLES: '0',
          SCAN_ENABLED: 'true',
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Resolved loop configuration:')
    expect(result.stdout).toContain('MAX_SCAN_CYCLES=0')
  })

  it('reports the Claude models resolved for scan, task, and review efforts', () => {
    const result = spawnSync(
      process.execPath,
      [CLI, 'loop', '--approve-mode', 'local'],
      {
        cwd: repoRoot,
        env: {
          ...CORE_ENV,
          AUTO_PR: 'false',
          ISSUE_QUEUE_ENABLED: 'false',
          MAX_SCAN_CYCLES: '0',
          RUNNER: 'claude',
          RUNNER_CLAUDE_MODEL: 'claude-base',
          RUNNER_CLAUDE_MODEL_MINIMAL: 'claude-scan',
          RUNNER_CLAUDE_MODEL_LOW: 'claude-review',
          RUNNER_CLAUDE_MODEL_HIGH: 'claude-task',
          SCAN_EFFORT: 'minimal',
          TASK_EFFORT: 'high',
          REVIEW_EFFORT: 'low',
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('scan: model=claude-scan effort=minimal')
    expect(result.stdout).toContain('task: model=claude-task effort=high')
    expect(result.stdout).toContain('review: model=claude-review effort=low')
    expect(result.stdout).not.toContain('(runner default)')
  })

  it('does not report a background daemon as started when the PID lock is held', () => {
    mkdirSync(dirname(daemonFile('loop.pid')), { recursive: true })
    writeFileSync(daemonFile('loop.pid'), processMarkerText(processMarker(process.pid)))

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local', '--daemon'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('Started the loop in the background')
    expect(result.stderr).toContain('Could not start the loop: Loop is already running')
  })

  it('does not replace a live daemon that owns a legacy bare-PID lock', () => {
    mkdirSync(dirname(daemonFile('loop.pid')), { recursive: true })
    writeFileSync(daemonFile('loop.pid'), `${process.pid}\n`)

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`Loop is already running (PID=${process.pid})`)
    expect(result.stdout).not.toContain('Removing stale PID file')
    expect(readFileSync(daemonFile('loop.pid'), 'utf8')).toBe(`${process.pid}\n`)
  })

  it('reclaims a loop marker when its live PID belongs to a different process start', () => {
    const paths = orchPaths(repoRoot)
    writeFileSync(
      daemonFile('loop.pid'),
      `${JSON.stringify({ pid: process.pid, startIdentity: 'not-the-current-process' })}\n`,
    )
    mkdirSync(join(paths.worktreesDir, 'orphan-after-reused-loop-pid'))

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Removing stale PID file')
    expect(result.stdout).not.toContain('Loop is already running')
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
  })

  it('returns a background daemon initialization error to its launcher', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'issue', '--daemon'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, FORGE: 'missing', ISSUE_QUEUE_ENABLED: 'true' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('Started the loop in the background')
    expect(result.stderr).toContain("Could not start the loop: Unknown FORGE 'missing'")
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
  })

  it('loads and prepares the project adapter from the integration worktree', () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    const projectDirectory = join(repoRoot, 'orchestration', 'project')
    const adapter = join(projectDirectory, 'project-test.ts')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(join(repoRoot, '.gitignore'), [
      'orchestration/logs/',
      'orchestration/queue/',
      'orchestration/status/',
      'orchestration/tasks/',
      'orchestration/worktrees/',
      '',
    ].join('\n'))
    const adapterSource = (withSetup: boolean) => [
      'export const project = {',
      "  name: 'test',",
      '  preCommitChecks: [],',
      "  pullRequest: { categories: [{ label: 'Changes' }], titleFallback: 'changes',",
      "    classifyCommit: () => ({ category: 'Changes' }), detectRisks: () => [] },",
      '  mergeChecks: () => [],',
      '  cycleSuite: () => [],',
      ...(withSetup ? [
        '  integrationWorktreeSetup: [{',
        "    label: 'Integration adapter', cwd: '',",
        `    command: ${JSON.stringify(
          "node -e \"require('node:fs').writeFileSync('integration-adapter-loaded', 'ready')\"",
        )},`,
        '  }],',
      ] : []),
      '}',
      '',
    ].join('\n')
    writeFileSync(adapter, adapterSource(false))
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: add daemon adapter'])
    git(['switch', '-q', '-c', 'integration/run'])
    writeFileSync(adapter, adapterSource(true))
    git(['add', '-A'])
    git(['commit', '-qm', 'fix: update integration adapter'])
    git(['switch', '-q', '-c', 'daemon/run', 'HEAD~1'])

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: {
        ...INHERITED_ENV,
        PROJECT: 'test',
        PROJECT_ADAPTER: '',
        INTEGRATION_BRANCH: 'integration/run',
        CORE_AUTO_UPDATE: 'false',
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(
      repoRoot, 'orchestration', 'worktrees', '.integration',
      'integration-adapter-loaded',
    ), 'utf8')).toBe('ready')
    expect(existsSync(join(repoRoot, 'integration-adapter-loaded'))).toBe(false)
  })

  it('repairs incomplete orchestration dependencies before loading the project adapter', () => {
    const packageRoot = join(repoRoot, 'orchestration', 'ts')
    const packageModules = join(packageRoot, 'node_modules')
    const require = createRequire(import.meta.url)
    const installedZod = dirname(require.resolve('zod/package.json'))
    const installedTypescript = dirname(dirname(require.resolve('typescript')))
    mkdirSync(packageModules, { recursive: true })
    cpSync(join(HERE, '..', 'src'), join(packageRoot, 'src'), { recursive: true })
    cpSync(join(HERE, '..', 'package.json'), join(packageRoot, 'package.json'))
    cpSync(join(HERE, '..', 'package-lock.json'), join(packageRoot, 'package-lock.json'))
    cpSync(installedZod, join(packageModules, 'zod'), { recursive: true })

    const cli = join(packageRoot, 'src', 'cli.ts')
    const installMarker = join(repoRoot, 'install-called')
    const wrapper = join(repoRoot, 'repair-dependencies.mjs')
    writeFileSync(wrapper, [
      "import childProcess from 'node:child_process'",
      "import { cpSync, writeFileSync } from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const originalExecSync = childProcess.execSync',
      'childProcess.execSync = function (command, options) {',
      "  if (String(command).startsWith('npm ci ')) {",
      `    cpSync(${JSON.stringify(installedTypescript)}, ${JSON.stringify(join(packageModules, 'typescript'))}, { recursive: true })`,
      `    writeFileSync(${JSON.stringify(installMarker)}, '')`,
      "    return options?.encoding ? '' : Buffer.from('')",
      '  }',
      '  return originalExecSync.call(this, command, options)',
      '}',
      'syncBuiltinESMExports()',
      `await import(${JSON.stringify(pathToFileURL(cli).href)})`,
      '',
    ].join('\n'))

    expect(existsSync(join(packageModules, 'typescript'))).toBe(false)
    const result = spawnSync(process.execPath, [wrapper, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: {
        ...CORE_ENV,
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
        SCAN_ENABLED: 'true',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(installMarker)).toBe(true)
    expect(result.stdout).toMatch(/Installed\s+orchestration deps\s+at startup/)
  })

  it('refuses startup while the task process registry names a foreign live PID', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260812_010203_040_auto-foreign-task'
    const foreignProcess = testProcesses.spawn(process.execPath, [
      '-e', 'setInterval(() => {}, 1000)',
    ], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const foreignPid = foreignProcess.pid
    expect(foreignPid).toBeTypeOf('number')
    writeFileSync(statusFile(paths, taskId), JSON.stringify({
      task_id: taskId,
      status: 'running',
      started_at: '2026-08-12T01:02:03Z',
      updated_at: '2026-08-12T01:02:03Z',
      worktree: worktreeDir(paths, taskId),
      branch: branchName(taskId),
      pid: foreignPid,
    }))
    // A task's process lives in the registry, not in the record.
    recordTaskProcess(paths, taskId, foreignPid as number)

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(taskId)
    expect(result.stdout).toContain(`foreign live process tree PID ${foreignPid}`)
    expect(result.stdout).toContain('terminate or adopt the foreign task before starting')
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('cycle-cap.txt'))).toBe(false)
  })

  it('refuses startup for a worktree with no task state and gives a holder diagnostic', () => {
    const paths = orchPaths(repoRoot)
    const orphan = join(paths.worktreesDir, 'orphan-without-status')
    mkdirSync(orphan, { recursive: true })

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    const displayedOrphan = join('orchestration', 'worktrees', 'orphan-without-status')
    expect(result.stdout).toContain(displayedOrphan)
    expect(result.stdout).toContain('has no task status')
    expect(result.stdout).toContain('something may still hold')
    expect(result.stdout).toMatch(process.platform === 'win32' ? /handle\.exe/ : /lsof \+D/)
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
  })

  it('allows only one of concurrent starts to acquire the PID lock', async () => {
    const wrapper = join(repoRoot, 'start-loop.mjs')
    const cliUrl = pathToFileURL(CLI).href
    writeFileSync(wrapper, [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const originalWriteFileSync = fs.writeFileSync',
      'fs.writeFileSync = function (file, ...args) {',
      '  const result = originalWriteFileSync.call(this, file, ...args)',
      "  if (typeof file === 'string' && /[\\\\/]loop\\.pid$/.test(file)) {",
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)',
      '  }',
      "  if (typeof file === 'string' && /[\\\\/]cycle-cap\\.txt$/.test(file)) {",
      "    const stop = file.replace(/cycle-cap\\.txt$/, 'stop')",
      '    while (!fs.existsSync(stop)) {',
      '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)',
      '    }',
      '  }',
      '  return result',
      '}',
      'syncBuiltinESMExports()',
      `await import(${JSON.stringify(cliUrl)})`,
      '',
    ].join('\n'))

    const children = Array.from({ length: 6 }, () => testProcesses.spawn(process.execPath, [wrapper, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: {
        ...CORE_ENV,
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        POLL_INTERVAL: '1',
        SCAN_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    }))
    const completions = children.map(childCompletion)

    await waitUntil(
      () => children.filter((child) => child.exitCode !== null).length >= children.length - 1,
      'competing loop starts did not reject the PID lock',
    )
    await waitUntil(
      () => existsSync(daemonFile('cycle-cap.txt')),
      'winning loop did not finish daemon initialization',
    )
    writeFileSync(daemonFile('stop'), '')
    const results = await Promise.all(completions)

    expect(results.filter((result) => result.code === 0)).toHaveLength(1)
    const rejected = results.filter((result) => result.code === 1)
    expect(rejected).toHaveLength(children.length - 1)
    expect(rejected.every((result) => result.output.includes('Loop is already running'))).toBe(true)
  })

  it('allows only one concurrent starter to reclaim a stale PID file', async () => {
    mkdirSync(dirname(daemonFile('loop.pid')), { recursive: true })
    writeFileSync(daemonFile('loop.pid'), '999999999\n')
    const wrapper = join(repoRoot, 'start-stale-loop.mjs')
    const cliUrl = pathToFileURL(CLI).href
    writeFileSync(wrapper, [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const originalWriteFileSync = fs.writeFileSync',
      'fs.writeFileSync = function (file, ...args) {',
      '  const result = originalWriteFileSync.call(this, file, ...args)',
      "  if (typeof file === 'string' && /[\\\\/]loop\\.pid$/.test(file)) {",
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)',
      '  }',
      "  if (typeof file === 'string' && /[\\\\/]cycle-cap\\.txt$/.test(file)) {",
      "    const stop = file.replace(/cycle-cap\\.txt$/, 'stop')",
      '    while (!fs.existsSync(stop)) {',
      '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)',
      '    }',
      '  }',
      '  return result',
      '}',
      'syncBuiltinESMExports()',
      `await import(${JSON.stringify(cliUrl)})`,
      '',
    ].join('\n'))

    const children = Array.from({ length: 6 }, () => testProcesses.spawn(process.execPath, [wrapper, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: {
        ...CORE_ENV,
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        POLL_INTERVAL: '1',
        SCAN_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    }))
    const completions = children.map(childCompletion)

    await waitUntil(
      () => children.filter((child) => child.exitCode !== null).length >= children.length - 1,
      'competing stale-PID recoveries did not settle on one owner',
    )
    await waitUntil(
      () => existsSync(daemonFile('cycle-cap.txt')),
      'winning stale-PID recovery did not finish daemon initialization',
    )
    writeFileSync(daemonFile('stop'), '')
    const results = await Promise.all(completions)

    expect(results.filter((result) => result.code === 0)).toHaveLength(1)
    const rejected = results.filter((result) => result.code === 1)
    expect(rejected).toHaveLength(children.length - 1)
    expect(rejected.every((result) => result.output.includes('Loop is already running'))).toBe(true)
    expect(existsSync(`${daemonFile('loop.pid')}.recovery`)).toBe(false)
  })

  it('reclaims an aged ownerless recovery directory', () => {
    const paths = orchPaths(repoRoot)
    const recovery = `${daemonFile('loop.pid')}.recovery`
    writeFileSync(daemonFile('loop.pid'), '999999999\n')
    mkdirSync(recovery)
    const past = (Date.now() - 60_000) / 1000
    utimesSync(recovery, past, past)
    mkdirSync(join(paths.worktreesDir, 'orphan-after-recovery'))

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Removing stale PID file')
    expect(existsSync(recovery)).toBe(false)
  })

  it('reclaims a recovery lock whose recorded owner has exited', () => {
    const paths = orchPaths(repoRoot)
    const recovery = `${daemonFile('loop.pid')}.recovery`
    writeFileSync(daemonFile('loop.pid'), '999999999\n')
    mkdirSync(recovery)
    writeFileSync(join(recovery, 'owner.json'), JSON.stringify({
      pid: 999999999,
      acquiredAt: new Date().toISOString(),
      token: 'abandoned-owner',
    }))
    mkdirSync(join(paths.worktreesDir, 'orphan-after-owner-recovery'))

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Removing stale PID file')
    expect(existsSync(recovery)).toBe(false)
  })

  it('reclaims a recovery lock when its live PID belongs to a different process start', () => {
    const paths = orchPaths(repoRoot)
    const recovery = `${daemonFile('loop.pid')}.recovery`
    writeFileSync(daemonFile('loop.pid'), '999999999\n')
    mkdirSync(recovery)
    writeFileSync(join(recovery, 'owner.json'), JSON.stringify({
      pid: process.pid,
      startIdentity: 'not-the-current-process',
      acquiredAt: new Date().toISOString(),
      token: 'reused-pid-owner',
    }))
    mkdirSync(join(paths.worktreesDir, 'orphan-after-reused-pid-recovery'))

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Removing stale PID file')
    expect(existsSync(recovery)).toBe(false)
  })

  it('prints a failed-task marker and preserves a same-branch merge streak', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260810_010203_031_auto-failed-task'
    await writeStatus(paths, taskId, 'failed')
    writeFileSync(daemonFile('run-branch.txt'), `${git(['branch', '--show-current']).trim()}\n`)
    writeFileSync(daemonFile('merge-failure-count.txt'), '2\n')
    // A task already failed at startup no longer trips the burst guard, so a queued
    // entry that keeps failing its startup stops the loop before the run can finish
    // and clear its session counters.
    const queuedId = '20260810_010204_032_auto-invalid-effort'
    writeFileSync(join(paths.tasksDir, `${queuedId}.md`), '# spec\n')
    mkdirSync(daemonFile('effort'), { recursive: true })
    writeFileSync(join(daemonFile('effort'), queuedId), 'impossible\n')
    writeFileSync(daemonFile('backlog.txt'), `${queuedId}:1\n`)

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: {
        ...CORE_ENV,
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_BURST_FAILURES: '1',
        POLL_INTERVAL: '0',
        SCAN_ENABLED: 'false',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stdout.split(/\r?\n/)).toContain(
      `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`,
    )
    expect(readFileSync(daemonFile('merge-failure-count.txt'), 'utf8')).toBe('2\n')
  })

  it('separates daemon markers from the aligned loop-log event', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260810_010203_032_auto-failed-task'
    const markerLog = join(paths.logsDir, 'loop-markers.log')
    await writeStatus(paths, taskId, 'failed')

    const result = spawnSync(
      process.execPath,
      [CLI, 'loop', '--approve-mode', 'local', '--marker-output', markerLog],
      {
        cwd: repoRoot,
        env: {
          ...CORE_ENV,
          AUTO_PR: 'false',
          ISSUE_QUEUE_ENABLED: 'false',
          MAX_BURST_FAILURES: '1',
          // The [loop 00/12] assertions below depend on the cycle cap; pin it so the
          // test does not inherit whatever MAX_SCAN_CYCLES a surrounding daemon exports.
          MAX_SCAN_CYCLES: '12',
          POLL_INTERVAL: '0',
          SCAN_ENABLED: 'false',
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    const marker = `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`
    const loopLogLines = result.stdout.split(/\r?\n/).filter((line) =>
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop /.test(line))
    expect(result.status).toBe(0)
    expect(readFileSync(markerLog, 'utf8')).toBe(`${marker}\n`)
    expect(loopLogLines).not.toContain(marker)
    expect(loopLogLines.every((line) =>
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 00\/12\] /.test(line))).toBe(true)
    expect(loopLogLines).toContainEqual(expect.stringMatching(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 00\/12\] Failed       032_auto\s+log 032_auto\.log$/,
    ))
    expect(loopLogLines.filter((line) => line.includes('032_auto'))).toHaveLength(1)
  })

  it('preserves the merge streak when startup fails before session initialization', () => {
    mkdirSync(dirname(daemonFile('merge-failure-count.txt')), { recursive: true })
    writeFileSync(daemonFile('merge-failure-count.txt'), '3\n')

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'issue'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, FORGE: 'missing', ISSUE_QUEUE_ENABLED: 'true' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown FORGE 'missing'")
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('issue-mode'))).toBe(false)
    expect(readFileSync(daemonFile('merge-failure-count.txt'), 'utf8')).toBe('3\n')
  })

  it('refreshes the cycle cap and removes daemon markers after a normal shutdown', () => {
    mkdirSync(dirname(daemonFile('cycle-cap.txt')), { recursive: true })
    writeFileSync(daemonFile('cycle-cap.txt'), '99\n')

    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: {
        ...CORE_ENV,
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
        SCAN_ENABLED: 'true',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Started      core        auto-update on')
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('issue-mode'))).toBe(false)
    expect(readFileSync(daemonFile('cycle-cap.txt'), 'utf8')).toBe('0\n')
  })

  it('rewrites the cycle cap when the live configuration changes it mid-run', () => {
    const configFile = join(repoRoot, 'orchestration', 'config.json')
    mkdirSync(dirname(configFile), { recursive: true })
    writeFileSync(configFile, JSON.stringify({ MAX_SCAN_CYCLES: 10 }))
    const wrapper = join(repoRoot, 'change-cap-loop.mjs')
    const cliUrl = pathToFileURL(CLI).href
    writeFileSync(wrapper, [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const originalWriteFileSync = fs.writeFileSync',
      'let changed = false',
      'fs.writeFileSync = function (file, ...args) {',
      '  const result = originalWriteFileSync.call(this, file, ...args)',
      "  if (!changed && typeof file === 'string' && /[\\\\/]cycle-cap\\.txt$/.test(file)) {",
      '    changed = true',
      `    originalWriteFileSync(${JSON.stringify(configFile)}, JSON.stringify({ MAX_SCAN_CYCLES: 0 }))`,
      '  }',
      '  return result',
      '}',
      'syncBuiltinESMExports()',
      `await import(${JSON.stringify(cliUrl)})`,
      '',
    ].join('\n'))

    const result = spawnSync(process.execPath, [wrapper, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: {
        ...CORE_ENV,
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        SCAN_ENABLED: 'true',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    // The first poll ends the run against the lowered cap, which the file must hold.
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("MAX_SCAN_CYCLES changed from '10' to '0'")
    expect(readFileSync(daemonFile('cycle-cap.txt'), 'utf8')).toBe('0\n')
  })

  it('states when automatic core updates are disabled', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop', '--approve-mode', 'local'], {
      cwd: repoRoot,
      env: {
        ...CORE_ENV,
        AUTO_PR: 'false',
        AUTO_REVIEW: 'false',
        CORE_AUTO_UPDATE: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
        SCAN_ENABLED: 'true',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Started      core        auto-update off')
  })

  async function runDaemonInProcess(
    poll: () => Promise<'stopped' | 'done' | 'continue' | 'restart'>,
    env: Record<string, string> = {},
  ): Promise<{ exitCode: number, startLoopReplacement: ReturnType<typeof vi.fn> }> {
    const startLoopReplacement = vi.fn(async () => ({ ok: true, pid: 1 }))
    vi.doMock('../src/adapters/runner.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/adapters/runner.ts')>(),
      loadRunner: async () => ({ sharedSkills: fakeRunnerSharedSkills, start: vi.fn() }),
    }))
    vi.doMock('../src/loop.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/loop.ts')>(),
      createLoop: () => ({
        validatePushTarget: () => true,
        initializeIssueQueue: async () => {},
        initializeSessionStateForBranch: () => {},
        poll,
        restartSubject: () => 'core',
      }),
    }))
    vi.doMock('../src/restart.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/restart.ts')>(),
      startLoopReplacement,
    }))
    vi.doMock('node:child_process', async (importOriginal) => {
      const childProcess = await importOriginal<typeof import('node:child_process')>()
      return {
        ...childProcess,
        execFileSync: (...args: Parameters<typeof execFileSync>) => {
          const [file, fileArgs] = args
          if (file === 'git' && fileArgs?.join(' ') === 'rev-parse --show-toplevel') {
            return repoRoot
          }
          return childProcess.execFileSync(...args)
        },
      }
    })
    vi.resetModules()

    const previousArgv = process.argv
    const previousExitCode = process.exitCode
    const previousEnv = { ...process.env }
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV, {
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
      }, env)
      process.exitCode = undefined
      process.argv = [process.execPath, CLI, 'loop', '--approve-mode', 'local']

      await import('../src/cli.ts')

      return { exitCode: process.exitCode ?? 0, startLoopReplacement }
    } finally {
      logs.mockRestore()
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      vi.doUnmock('../src/adapters/runner.ts')
      vi.doUnmock('../src/loop.ts')
      vi.doUnmock('../src/restart.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  }

  it('exits instead of handing over when a stop arrives during a restarting poll', async () => {
    const result = await runDaemonInProcess(async () => {
      writeFileSync(daemonFile('stop'), '')
      return 'restart'
    })

    expect(result.exitCode).toBe(0)
    expect(result.startLoopReplacement).not.toHaveBeenCalled()
  })

  it('keeps a stop sent during the handover when a replacement takes over the PID lock', async () => {
    mkdirSync(dirname(daemonFile('stop')), { recursive: true })
    writeFileSync(daemonFile('loop.pid'), processMarkerText(processMarker(process.pid)))
    writeFileSync(daemonFile('stop'), '')
    const outcomes: string[] = []

    const result = await runDaemonInProcess(async () => {
      const outcome = existsSync(daemonFile('stop')) ? 'stopped' : 'done'
      outcomes.push(outcome)
      return outcome
    }, { ORCHESTRATION_LOOP_RESTART_PREDECESSOR_PID: `${process.pid}` })

    expect(result.exitCode).toBe(0)
    expect(outcomes).toEqual(['stopped'])
  })
})

describe('stop', () => {
  it('does not publish stop or terminate a live scan when its cycle counter is invalid', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260812_010203_040_scan'
    const scan = testProcesses.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const scanPid = scan.pid
    expect(scanPid).toBeTypeOf('number')
    scan.unref()

    await writeStatus(paths, taskId, 'running', scanPid)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), 'not-a-cycle\n')

    const result = spawnSync(process.execPath, [CLI, 'stop'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('queue/scan-count.txt must contain a positive integer')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop-interrupted-scans'))).toBe(false)
    expect(pidIsAlive(scanPid as number)).toBe(true)
  })

  it('does not publish stop or terminate a live scan when its cycle counter is not a safe integer', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260812_010203_042_scan'
    const scan = testProcesses.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const scanPid = scan.pid
    expect(scanPid).toBeTypeOf('number')
    scan.unref()

    await writeStatus(paths, taskId, 'running', scanPid)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '9007199254740993\n')

    const result = spawnSync(process.execPath, [CLI, 'stop'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Cannot stop live scans: queue/scan-count.txt must contain a safe integer; '
      + 'no stop file was created.',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop-interrupted-scans'))).toBe(false)
    expect(pidIsAlive(scanPid as number)).toBe(true)
  })

  it('terminates a running task process tree and reports the task and PID', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260812_010203_041_scan'
    const childPidFile = join(repoRoot, 'child.pid')
    testProcesses.trackPid(() => {
      if (!existsSync(childPidFile)) return undefined
      return Number(readFileSync(childPidFile, 'utf8'))
    })
    const parent = testProcesses.spawn(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))`,
      'setInterval(() => {}, 1000)',
    ].join(';')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const parentPid = parent.pid
    expect(parentPid).toBeTypeOf('number')
    parent.unref()

    await waitUntil(() => existsSync(childPidFile), 'task child did not publish its PID')
    const childPid = Number(readFileSync(childPidFile, 'utf8'))
    expect(pidIsAlive(parentPid as number)).toBe(true)
    expect(pidIsAlive(childPid)).toBe(true)
    await writeStatus(paths, taskId, 'running', parentPid)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '2\n')

    const result = spawnSync(process.execPath, [CLI, 'stop'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Stopped ${taskId}`)
    expect(result.stdout).toContain(`process tree PID ${parentPid}`)
    expect(readFileSync(join(paths.queueDir, 'stop-interrupted-scans'), 'utf8'))
      .toBe(`2\t${taskId}\n`)
    await waitUntil(
      () => !pidIsAlive(parentPid as number) && !pidIsAlive(childPid),
      'stop left a task process or its child running',
    )
  })

  it('reports when there are no live task process trees to terminate', () => {
    const result = spawnSync(process.execPath, [CLI, 'stop'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Stopped tasks')
    expect(result.stdout).toContain('no live process trees')
  })
})
