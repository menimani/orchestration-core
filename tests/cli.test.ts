import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordIssueForTask } from '../src/issueQueue.ts'
import { branchName, orchPaths, statusFile, worktreeDir } from '../src/paths.ts'
import { recordTaskProcess } from '../src/processRegistry.ts'
import { writeStatus } from '../src/status.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.ts')

// Several of these run `cli.ts loop` and rely on the loop deciding to exit — a
// burst-failure cap, an exhausted cycle cap, a rejected PID lock. When a condition stops
// holding, a synchronous spawn becomes a permanent block: `spawnSync` cannot be
// interrupted by vitest's test timeout, so the worker freezes with no failure and no
// output. That happened inside a merge gate twice, and each attempt sat for fifty minutes
// before anyone thought to look at the process list. A bound turns it into a failed test.
const CLI_TIMEOUT_MS = 120_000

// The loop reads its settings from the environment, so inheriting the caller's is enough
// to change what the CLI under test does. An operator running the suite in a checkout
// where a loop is started with `CORE_AUTO_UPDATE=false` made a test asserting
// `auto-update on` fail, which then blocked every merge in that repository until the
// variable was noticed. Only the settings a test sets deliberately may reach the child.
const INHERITED_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !isLoopSetting(name)),
)

function isLoopSetting(name: string): boolean {
  return name === 'PROJECT' || name === 'PROJECT_ADAPTER' || name === 'FORGE'
    || name === 'RUNNER' || name === 'UPSTREAM_REMOTE' || name === 'UPSTREAM_BRANCH'
    || /^(CORE_|MAX_|SCAN_|TASK_|REVIEW_|ISSUE_|CI_|AUTO_|POLL_)/.test(name)
}

const CORE_ENV = {
  ...INHERITED_ENV,
  PROJECT: 'shiora',
  PROJECT_ADAPTER: join(HERE, 'fixtures', 'project-loader-fixture.ts'),
}

let repoRoot: string

beforeEach(() => {
  // The runner's temp path contains an 8.3 short name when the account name is long
  // (RUNNER~1 for runneradmin), while paths the CLI reports are canonical. Compare like
  // with like, or the assertions differ only in a place no developer machine reproduces.
  repoRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'orch-cli-')))
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

function childCompletion(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, output }))
  })
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('command registry', () => {
  it('lists deploy as an available command', () => {
    const result = spawnSync(process.execPath, [CLI, 'unknown'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('deploy')
    expect(result.stderr).toContain('ci-wait')
    expect(result.stderr).toContain('report-upstream')
    expect(result.stderr).toContain('init')
    expect(result.stderr).toContain('verify-setup')
  })

  it('refuses to start a worker without a base ref', () => {
    const result = spawnSync(process.execPath, [CLI, 'worker'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage: worker <base-ref>')
  })

  it('reads runner-neutral task settings when manually starting a task', () => {
    const result = spawnSync(process.execPath, [CLI, 'start', 'manual-task'], {
      cwd: repoRoot,
      env: {
        ...CORE_ENV,
        TASK_EFFORT: 'maximum',
        CODEX_EFFORT: 'low',
        CODEX_MODEL: 'codex-specific-model',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("TASK_EFFORT must be minimal, low, medium or high, got 'maximum'")
    expect(readFileSync(CLI, 'utf8')).not.toMatch(/CODEX_(?:EFFORT|MODEL)/)
  })
})

describe('report-upstream arguments', () => {
  it('prints command usage for --help without loading the forge', () => {
    const result = spawnSync(process.execPath, [CLI, 'report-upstream', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, FORGE: 'missing' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage: report-upstream [--dry-run] "<description>"')
    expect(result.stderr).not.toContain('Unknown FORGE')
  })

  it('rejects an unrecognised flag without loading the forge', () => {
    const result = spawnSync(
      process.execPath,
      [CLI, 'report-upstream', '--anything', 'This must not become issue text.'],
      {
        cwd: repoRoot,
        env: { ...process.env, FORGE: 'missing' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ERROR: unknown option: --anything')
    expect(result.stderr).not.toContain('Unknown FORGE')
  })

  it('prints a report for --dry-run without loading the forge', () => {
    const result = spawnSync(
      process.execPath,
      [CLI, 'report-upstream', '--dry-run', 'A safely previewed defect.'],
      {
        cwd: repoRoot,
        env: { ...process.env, FORGE: 'missing' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Title:\nCore defect reported by ')
    expect(result.stdout).toContain('Body:\n## Requirement\n\nA safely previewed defect.')
    expect(result.stderr).not.toContain('Unknown FORGE')
  })
})

describe('logs', () => {
  it('returns a failure when a log follower cannot read a regular file', () => {
    const paths = orchPaths(repoRoot)
    const taskId = 'directory-log'
    mkdirSync(join(paths.logsDir, taskId + '.log'), { recursive: true })

    const result = spawnSync(process.execPath, [CLI, 'logs', taskId, '-f'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Cannot follow a non-file')
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
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(git(['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration (closes #197)`,
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

  it('forwards failed check output before reporting the merge failure', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20260808_000000_002_user-failed-check'
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(join(worktree, 'work.txt'), 'done\n')
    git(['add', '-A'], worktree)
    git(['commit', '-qm', 'fix: complete task with failed check'], worktree)
    await writeStatus(paths, taskId, 'completed')

    const command = 'node -e "console.log(\'check stdout\'); console.error(\'check stderr\'); process.exit(1)"'
    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes', '--test-cmd', command], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('check stdout')
    expect(result.stderr).toContain('check stderr')
    expect(result.stderr).toContain('Tests failed. Aborting merge.')
  })
})

describe('manually promoted run ending', () => {
  it('records a Completed Loop event and the LOOP_DONE marker', () => {
    const paths = orchPaths(repoRoot)
    mkdirSync(paths.queueDir, { recursive: true })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '12\n')
    writeFileSync(join(paths.queueDir, 'cycle-cap.txt'), '12\n')

    const result = spawnSync(process.execPath, [CLI, 'shipped', '322'], {
      cwd: repoRoot,
      env: { ...INHERITED_ENV, MAX_SCAN_CYCLES: '3' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    const logged = readFileSync(join(paths.logsDir, 'loop.log'), 'utf8')
    expect(logged).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 12\/12\] Completed {2}Loop {8}PR #322\r?\n$/,
    )
    expect(readFileSync(join(paths.logsDir, 'loop-markers.log'), 'utf8'))
      .toBe('LOOP_DONE: 322\n')
  })

  it('falls back to its configured cycle cap when no daemon cap was recorded', () => {
    const paths = orchPaths(repoRoot)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '5\n')

    const result = spawnSync(process.execPath, [CLI, 'shipped', '323'], {
      cwd: repoRoot,
      env: { ...INHERITED_ENV, MAX_SCAN_CYCLES: '8' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(readFileSync(join(paths.logsDir, 'loop.log'), 'utf8')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 05\/08\] Completed {2}Loop {8}PR #323\r?\n$/,
    )
  })

  it('rejects a call without a pull request reference', () => {
    const result = spawnSync(process.execPath, [CLI, 'shipped'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage: shipped')
  })
})

describe('loop daemon ownership', () => {
  it('refuses startup while a task status names a foreign live PID', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260812_010203_040_auto-foreign-task'
    writeFileSync(statusFile(paths, taskId), JSON.stringify({
      task_id: taskId,
      status: 'running',
      pid: process.pid,
    }))
    // A task's process lives in the registry, not in the record.
    recordTaskProcess(paths, taskId, process.pid)

    const result = spawnSync(process.execPath, [CLI, 'loop'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(taskId)
    expect(result.stdout).toContain(`foreign live process tree PID ${process.pid}`)
    expect(result.stdout).toContain('terminate or adopt the foreign task before starting')
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('cycle-cap.txt'))).toBe(false)
  })

  it('refuses startup for a worktree with no task state and gives a holder diagnostic', () => {
    const paths = orchPaths(repoRoot)
    const orphan = join(paths.worktreesDir, 'orphan-without-status')
    mkdirSync(orphan, { recursive: true })

    const result = spawnSync(process.execPath, [CLI, 'loop'], {
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
      '  return result',
      '}',
      'syncBuiltinESMExports()',
      `await import(${JSON.stringify(cliUrl)})`,
      '',
    ].join('\n'))

    const children = Array.from({ length: 6 }, () => spawn(process.execPath, [wrapper, 'loop'], {
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

    try {
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
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill()
      }
    }
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
      '  return result',
      '}',
      'syncBuiltinESMExports()',
      `await import(${JSON.stringify(cliUrl)})`,
      '',
    ].join('\n'))

    const children = Array.from({ length: 6 }, () => spawn(process.execPath, [wrapper, 'loop'], {
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

    try {
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
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill()
      }
    }
  })

  it('reclaims an aged ownerless recovery directory', () => {
    const paths = orchPaths(repoRoot)
    const recovery = `${daemonFile('loop.pid')}.recovery`
    writeFileSync(daemonFile('loop.pid'), '999999999\n')
    mkdirSync(recovery)
    const past = (Date.now() - 60_000) / 1000
    utimesSync(recovery, past, past)
    mkdirSync(join(paths.worktreesDir, 'orphan-after-recovery'))

    const result = spawnSync(process.execPath, [CLI, 'loop'], {
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

    const result = spawnSync(process.execPath, [CLI, 'loop'], {
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

  it('prints a failed-task contract marker as an exact standalone line', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260810_010203_031_auto-failed-task'
    await writeStatus(paths, taskId, 'failed')

    const result = spawnSync(process.execPath, [CLI, 'loop'], {
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
  })

  it('separates daemon markers from the aligned loop-log event', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260810_010203_032_auto-failed-task'
    const markerLog = join(paths.logsDir, 'loop-markers.log')
    await writeStatus(paths, taskId, 'failed')

    const result = spawnSync(
      process.execPath,
      [CLI, 'loop', '--marker-output', markerLog],
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
    const loopLogLines = result.stdout.split(/\r?\n/).filter((line) => line !== '')
    expect(result.status).toBe(0)
    expect(readFileSync(markerLog, 'utf8')).toBe(`${marker}\n`)
    expect(loopLogLines).not.toContain(marker)
    expect(loopLogLines.every((line) =>
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 00\/12\] /.test(line))).toBe(true)
    expect(loopLogLines).toContainEqual(expect.stringMatching(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 00\/12\] Failed     032_auto\s+log 032_auto\.log$/,
    ))
    expect(loopLogLines.filter((line) => line.includes('032_auto'))).toHaveLength(1)
  })

  it('removes the PID and issue marker after a startup failure', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop'], {
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
  })

  it('refreshes the cycle cap and removes daemon markers after a normal shutdown', () => {
    mkdirSync(dirname(daemonFile('cycle-cap.txt')), { recursive: true })
    writeFileSync(daemonFile('cycle-cap.txt'), '99\n')

    const result = spawnSync(process.execPath, [CLI, 'loop'], {
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
    expect(result.stdout).toContain('Started    core        auto-update on')
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('issue-mode'))).toBe(false)
    expect(readFileSync(daemonFile('cycle-cap.txt'), 'utf8')).toBe('0\n')
  })

  it('states when automatic core updates are disabled', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop'], {
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
    expect(result.stdout).toContain('Started    core        auto-update off')
  })
})

describe('stop', () => {
  it('terminates a running task process tree and reports the task and PID', async () => {
    const paths = orchPaths(repoRoot)
    const taskId = '20260812_010203_041_auto-stop-tree'
    const childPidFile = join(repoRoot, 'child.pid')
    const parent = spawn(process.execPath, ['-e', [
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

    let childPid = 0
    try {
      await waitUntil(() => existsSync(childPidFile), 'task child did not publish its PID')
      childPid = Number(readFileSync(childPidFile, 'utf8'))
      expect(pidIsAlive(parentPid as number)).toBe(true)
      expect(pidIsAlive(childPid)).toBe(true)
      await writeStatus(paths, taskId, 'running', parentPid)

      const result = spawnSync(process.execPath, [CLI, 'stop'], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`Stopped ${taskId}`)
      expect(result.stdout).toContain(`process tree PID ${parentPid}`)
      await waitUntil(
        () => !pidIsAlive(parentPid as number) && !pidIsAlive(childPid),
        'stop left a task process or its child running',
      )
    } finally {
      if (typeof parentPid === 'number' && pidIsAlive(parentPid)) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(parentPid), '/T', '/F'], { windowsHide: true })
        } else {
          try { process.kill(-parentPid, 'SIGKILL') } catch { /* already gone */ }
        }
      }
      if (childPid > 0 && pidIsAlive(childPid)) {
        try { process.kill(childPid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
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
