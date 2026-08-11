import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordIssueForTask } from '../src/issueQueue.ts'
import { branchName, orchPaths, worktreeDir } from '../src/paths.ts'
import { writeStatus } from '../src/status.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.ts')
const CORE_ENV = {
  ...process.env,
  PROJECT: 'shiora',
  PROJECT_ADAPTER: join(HERE, 'fixtures', 'project-loader-fixture.ts'),
}

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
    expect(result.stderr).toContain('report-upstream')
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
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("TASK_EFFORT must be minimal, low, medium or high, got 'maximum'")
    expect(readFileSync(CLI, 'utf8')).not.toMatch(/CODEX_(?:EFFORT|MODEL)/)
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
      env: { ...process.env, MAX_SCAN_CYCLES: '3' },
      encoding: 'utf8',
      windowsHide: true,
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
      env: { ...process.env, MAX_SCAN_CYCLES: '8' },
      encoding: 'utf8',
      windowsHide: true,
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
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage: shipped')
  })
})

describe('loop daemon ownership', () => {
  it('allows only one of concurrent starts to acquire the PID lock', async () => {
    const wrapper = join(repoRoot, 'start-loop.mjs')
    const cliUrl = pathToFileURL(CLI).href
    writeFileSync(wrapper, [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const originalWriteFileSync = fs.writeFileSync',
      'fs.writeFileSync = function (file, ...args) {',
      "  if (typeof file === 'string' && /[\\\\/]loop\\.pid$/.test(file)) {",
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)',
      '  }',
      '  return originalWriteFileSync.call(this, file, ...args)',
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
      "  if (typeof file === 'string' && /[\\\\/]loop\\.pid$/.test(file)) {",
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)',
      '  }',
      '  return originalWriteFileSync.call(this, file, ...args)',
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
    })

    expect(result.status).toBe(0)
    expect(result.stdout.split(/\r?\n/)).toContain(
      `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`,
    )
  })

  it('separates daemon markers while formatting their loop-log copies', async () => {
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
      },
    )

    const marker = `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`
    const loopLogLines = result.stdout.split(/\r?\n/).filter((line) => line !== '')
    expect(result.status).toBe(0)
    expect(readFileSync(markerLog, 'utf8')).toBe(`${marker}\n`)
    expect(loopLogLines).not.toContain(marker)
    expect(loopLogLines.every((line) =>
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 00\/12\] /.test(line))).toBe(true)
    expect(loopLogLines).toContainEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 00\/12\] FAILED:/),
    )
  })

  it('removes the PID and issue marker after a startup failure', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, FORGE: 'missing', ISSUE_QUEUE_ENABLED: 'true' },
      encoding: 'utf8',
      windowsHide: true,
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
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Mode       core        auto-update on')
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
        CORE_AUTO_UPDATE: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
      },
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Mode       core        auto-update off')
  })
})
