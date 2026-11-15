import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { DaemonLaunchOptions, DaemonProcess } from '../src/adapters/os.ts'
import { LOOP_STARTUP_RESULT_FILE_ENV } from '../src/internalEnvironment.ts'
import { orchPaths } from '../src/paths.ts'
import { processMarker, processMarkerText } from '../src/processMarker.ts'
import { writeStatus } from '../src/status.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import {
  childCompletion, CLI, CLI_TIMEOUT_MS, CORE_ENV, daemonFile, git, pidIsAlive, repoRoot, testProcesses, waitUntil,
} from './cliHarness.ts'

describe('loop daemon ownership', () => {
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

  it('persists a mid-run cycle cap change for a later shipped record', async () => {
    const paths = orchPaths(repoRoot)
    const configFile = join(paths.projectRoot, 'config.json')
    mkdirSync(paths.projectRoot, { recursive: true })
    writeFileSync(configFile, JSON.stringify({ MAX_SCAN_CYCLES: 5 }))
    // Hold the daemon after its startup cap write so the configuration changes while it
    // runs, before its first poll.
    const wrapper = join(repoRoot, 'start-held-loop.mjs')
    const cliUrl = pathToFileURL(CLI).href
    writeFileSync(wrapper, [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const originalWriteFileSync = fs.writeFileSync',
      'fs.writeFileSync = function (file, ...args) {',
      '  const result = originalWriteFileSync.call(this, file, ...args)',
      "  if (typeof file === 'string' && /[\\\\/]cycle-cap\\.txt$/.test(file)) {",
      "    const release = file.replace(/cycle-cap\\.txt$/, 'release')",
      '    while (!fs.existsSync(release)) {',
      '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)',
      '    }',
      '  }',
      '  return result',
      '}',
      'syncBuiltinESMExports()',
      `await import(${JSON.stringify(cliUrl)})`,
      '',
    ].join('\n'))

    const child = testProcesses.spawn(process.execPath, [wrapper, 'loop', '--approve-mode', 'local'], {
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
    })
    const completion = childCompletion(child)

    await waitUntil(
      () => existsSync(daemonFile('cycle-cap.txt'))
        && readFileSync(daemonFile('cycle-cap.txt'), 'utf8') === '5\n',
      'loop did not record its startup cycle cap',
    )
    expect(readFileSync(daemonFile('cycle-cap.txt'), 'utf8')).toBe('5\n')
    writeFileSync(configFile, JSON.stringify({ MAX_SCAN_CYCLES: 12 }))
    writeFileSync(daemonFile('stop'), '')
    writeFileSync(daemonFile('release'), '')
    const result = await completion

    expect(result.code, result.output).toBe(0)
    expect(readFileSync(daemonFile('cycle-cap.txt'), 'utf8')).toBe('12\n')

    // shipped must read the cap the run ended on, not the configuration as it is now.
    writeFileSync(configFile, JSON.stringify({ MAX_SCAN_CYCLES: 20 }))
    writeFileSync(daemonFile('scan-count.txt'), '4\n')
    const shipped = spawnSync(process.execPath, [CLI, 'shipped', '#41'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(shipped.status, shipped.stderr).toBe(0)
    expect(readFileSync(join(paths.logsDir, 'loop.log'), 'utf8')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 04\/12\] Completed {4}Loop {8}PR #41\r?\n$/,
    )
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

describe('loop daemon startup failures', () => {
  const STARTUP_TIMEOUT_MS = 50

  interface StubDaemon extends DaemonProcess {
    terminate: Mock<() => void>
    release: Mock<() => void>
  }

  function stubDaemon(pid: number): StubDaemon & { emitError(error: Error): void } {
    const errorListeners = new Set<(error: Error) => void>()
    return {
      pid,
      isAlive: () => true,
      terminate: vi.fn<() => void>(),
      release: vi.fn<() => void>(),
      onError: (listener) => { errorListeners.add(listener) },
      offError: (listener) => { errorListeners.delete(listener) },
      onExit: () => {},
      offExit: () => {},
      emitError: (error) => { for (const listener of errorListeners) listener(error) },
    }
  }

  // The launcher runs in this process against a stub daemon, so each outcome is decided
  // by what the stub does, and the thirty-second startup allowance is cut to a few
  // milliseconds by capping the deadline the launcher recomputes on every poll.
  async function startDaemonInProcess(
    daemon: DaemonProcess,
    onLaunch: (options: DaemonLaunchOptions) => void = () => {},
  ): Promise<{ exitCode: number, errors: string[], logs: string[] }> {
    vi.doMock('../src/adapters/runner.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/adapters/runner.ts')>(),
      loadRunner: async () => ({ sharedSkills: fakeRunnerSharedSkills, start: vi.fn() }),
    }))
    vi.doMock('../src/adapters/os.ts', async (importOriginal) => {
      const os = await importOriginal<typeof import('../src/adapters/os.ts')>()
      vi.spyOn(os.operatingSystem, 'launchDaemon').mockImplementation(async (options) => {
        onLaunch(options)
        return daemon
      })
      return os
    })
    vi.doMock('../src/startupInstall.ts', async (importOriginal) => {
      const startupInstall = await importOriginal<typeof import('../src/startupInstall.ts')>()
      let cap: number | undefined
      return {
        ...startupInstall,
        startupDeadline: (...args: Parameters<typeof startupInstall.startupDeadline>) => {
          cap ??= Date.now() + STARTUP_TIMEOUT_MS
          return Math.min(startupInstall.startupDeadline(...args), cap)
        },
      }
    })
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
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV, {
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
      })
      process.exitCode = undefined
      process.argv = [process.execPath, CLI, 'loop', '--approve-mode', 'local', '--daemon']

      await import('../src/cli.ts')

      return {
        exitCode: process.exitCode ?? 0,
        errors: errors.mock.calls.map((call) => String(call[0])),
        logs: logs.mock.calls.map((call) => String(call[0])),
      }
    } finally {
      errors.mockRestore()
      logs.mockRestore()
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      vi.doUnmock('../src/adapters/runner.ts')
      vi.doUnmock('../src/adapters/os.ts')
      vi.doUnmock('../src/startupInstall.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  }

  const loopLog = (): string => join(orchPaths(repoRoot).logsDir, 'loop.log')

  it('terminates a daemon that never reports readiness before the startup timeout', async () => {
    const daemon = stubDaemon(43210)

    const result = await startDaemonInProcess(daemon)

    expect(result.exitCode).toBe(1)
    expect(daemon.terminate).toHaveBeenCalledOnce()
    expect(daemon.release).not.toHaveBeenCalled()
    expect(result.errors.slice(-2)).toEqual([
      'Could not start the loop: daemon did not initialize before the startup timeout',
      `Log: ${loopLog()}`,
    ])
    expect(result.logs.some((line) => line.startsWith('Started the loop in the background')))
      .toBe(false)
  })

  it('reports a failed cleanup when the timed-out daemon cannot be terminated', async () => {
    const daemon = stubDaemon(43210)
    daemon.terminate.mockImplementation(() => {
      throw new Error('Could not stop process tree 43210.\nsecond line')
    })

    const result = await startDaemonInProcess(daemon)

    expect(result.exitCode).toBe(1)
    expect(daemon.terminate).toHaveBeenCalledOnce()
    expect(result.errors.slice(-2)).toEqual([
      'Could not start the loop: daemon did not initialize before the startup timeout; '
        + 'cleanup failed: Could not stop process tree 43210.',
      `Log: ${loopLog()}`,
    ])
  })

  it('terminates a daemon whose startup result names another PID', async () => {
    const daemon = stubDaemon(43210)
    let resultFile: string | undefined

    const result = await startDaemonInProcess(daemon, (options) => {
      resultFile = options.env?.[LOOP_STARTUP_RESULT_FILE_ENV]
      writeFileSync(resultFile!, `${JSON.stringify({ status: 'ready', pid: 43211 })}\n`)
    })

    expect(result.exitCode).toBe(1)
    expect(daemon.terminate).toHaveBeenCalledOnce()
    expect(daemon.release).not.toHaveBeenCalled()
    expect(result.errors.slice(-2)).toEqual([
      'Could not start the loop: daemon published an unexpected PID (43211)',
      `Log: ${loopLog()}`,
    ])
    expect(resultFile).toBeDefined()
    expect(existsSync(resultFile!)).toBe(false)
  })

  it('reports a failed cleanup when the daemon naming another PID cannot be terminated', async () => {
    const daemon = stubDaemon(43210)
    daemon.terminate.mockImplementation(() => { throw new Error('access denied') })

    const result = await startDaemonInProcess(daemon, (options) => {
      writeFileSync(
        options.env![LOOP_STARTUP_RESULT_FILE_ENV]!,
        `${JSON.stringify({ status: 'ready', pid: 43211 })}\n`,
      )
    })

    expect(result.exitCode).toBe(1)
    expect(daemon.terminate).toHaveBeenCalledOnce()
    expect(result.errors.slice(-2)).toEqual([
      'Could not start the loop: daemon published an unexpected PID (43211); '
        + 'cleanup failed: access denied',
      `Log: ${loopLog()}`,
    ])
  })

  it('returns a spawn error reported through the daemon error listener', async () => {
    const daemon = stubDaemon(43210)

    const result = await startDaemonInProcess(daemon, () => {
      setTimeout(() => daemon.emitError(new Error('spawn node ENOENT\ndetail')), 0)
    })

    expect(result.exitCode).toBe(1)
    // A spawn error means the process never started, so there is nothing to terminate;
    // the deadline has not passed, so the timeout path did not stop it either.
    expect(daemon.terminate).not.toHaveBeenCalled()
    expect(daemon.release).not.toHaveBeenCalled()
    expect(result.errors.slice(-2)).toEqual([
      'Could not start the loop: spawn node ENOENT',
      `Log: ${loopLog()}`,
    ])
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
