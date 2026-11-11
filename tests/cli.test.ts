import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { issueCompletionForIssue, recordIssuesForTask } from '../src/issueQueue.ts'
import {
  branchName, finalMessageFile, orchPaths, shellPathSpelling, worktreeDir,
} from '../src/paths.ts'
import { processMarker, processMarkerText } from '../src/processMarker.ts'
import { writeStatus } from '../src/status.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import {
  CLI, CLI_TIMEOUT_MS, CORE_ENV, extraRoots, git, INHERITED_ENV, repoRoot,
} from './cliHarness.ts'

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

  it('lists only package scripts, under the npm prefix, when no command is given', () => {
    const result = spawnSync(process.execPath, [CLI], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    const [usage, available] = result.stderr.trim().split('\n')
    expect(usage).toBe('Usage: npm run <command>')
    const scripts = Object.keys(
      (createRequire(import.meta.url)('../package.json') as { scripts: Record<string, string> })
        .scripts,
    )
    const listed = available!.replace(/^Available: /, '').split(', ')
    expect(listed).not.toContain('pre-commit')
    expect(listed.filter((name) => !scripts.includes(name))).toEqual([])
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

  it('reads runner-neutral task settings when manually starting a task', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])
    const paths = orchPaths(repoRoot)
    writeFileSync(join(paths.tasksDir, 'manual-task.md'), '# manual task\n')

    const start = vi.fn(async () => process.pid)
    vi.doMock('../src/adapters/runner.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/adapters/runner.ts')>(),
      loadRunner: async () => ({ sharedSkills: fakeRunnerSharedSkills, start }),
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
    try {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV, {
        RUNNER: 'fake',
        TASK_EFFORT: 'high',
        TASK_MODEL: 'runner-neutral-model',
      })
      process.argv = [process.execPath, CLI, 'start', 'manual-task']

      await import('../src/cli.ts')

      expect(process.exitCode).toBe(0)
      expect(start).toHaveBeenCalledWith(expect.objectContaining({
        effort: 'high',
        model: 'runner-neutral-model',
      }))
    } finally {
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      vi.doUnmock('../src/adapters/runner.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})

describe('repository selection', () => {
  it('resolves an explicit repository other than the working directory', () => {
    const otherRepo = join(repoRoot, 'other-repository')
    mkdirSync(otherRepo)
    expect(spawnSync('git', ['init'], { cwd: otherRepo, windowsHide: true }).status).toBe(0)
    mkdirSync(join(otherRepo, 'orchestration'))

    const result = spawnSync(
      process.execPath,
      [CLI, 'new', 'explicit-repository-task', '--repo', otherRepo],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(otherRepo, 'orchestration', 'tasks', 'explicit-repository-task.md')))
      .toBe(true)
    expect(existsSync(join(repoRoot, 'orchestration', 'tasks', 'explicit-repository-task.md')))
      .toBe(false)
  })

  it('resolves a relative repository from the caller\'s directory rather than the package', () => {
    const otherRepo = join(repoRoot, 'other-repository')
    mkdirSync(otherRepo)
    expect(spawnSync('git', ['init'], { cwd: otherRepo, windowsHide: true }).status).toBe(0)
    mkdirSync(join(otherRepo, 'orchestration'))
    // npm run -C moves the working directory to the package and keeps the caller's in INIT_CWD.
    const packageDirectory = join(repoRoot, 'package')
    mkdirSync(packageDirectory)

    const result = spawnSync(
      process.execPath,
      [CLI, 'new', 'relative-repository-task', '--repo', 'other-repository'],
      {
        cwd: packageDirectory,
        env: { ...INHERITED_ENV, INIT_CWD: repoRoot },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(otherRepo, 'orchestration', 'tasks', 'relative-repository-task.md')))
      .toBe(true)
  })

  it('continues to resolve the repository from the working directory without the option', () => {
    const result = spawnSync(process.execPath, [CLI, 'new', 'working-directory-task'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(repoRoot, 'orchestration', 'tasks', 'working-directory-task.md')))
      .toBe(true)
  })

  it('reports an explicit path that is not a git repository', () => {
    const notRepository = mkdtempSync(join(tmpdir(), 'orch-cli-not-repo-'))
    extraRoots.push(notRepository)

    const result = spawnSync(
      process.execPath,
      [CLI, 'loop-status', '--repo', notRepository],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Repository path '${notRepository}' is not a git repository.`)
  })

  it('accepts the --repo=<path> form and rejects an empty value', () => {
    const notRepository = mkdtempSync(join(tmpdir(), 'orch-cli-not-repo-'))
    extraRoots.push(notRepository)
    const run = (arg: string) => spawnSync(process.execPath, [CLI, 'loop-status', arg], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    const explicit = run(`--repo=${notRepository}`)
    const empty = run('--repo=')

    expect(explicit.status).toBe(1)
    expect(explicit.stderr).toContain(`Repository path '${notRepository}' is not a git repository.`)
    expect(empty.status).toBe(1)
    expect(empty.stderr).toContain('--repo requires a repository path')
  })

  it('reports an explicit git repository without an orchestration directory', () => {
    const repository = join(repoRoot, 'repository-without-orchestration')
    mkdirSync(repository)
    expect(spawnSync('git', ['init'], { cwd: repository, windowsHide: true }).status).toBe(0)

    const result = spawnSync(
      process.execPath,
      [CLI, 'loop-status', '--repo', repository],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is missing its orchestration directory')
    expect(result.stderr).toContain(join(repository, 'orchestration'))
  })

  it('reports two repositories with one fleet-status line each', async () => {
    const firstPaths = orchPaths(repoRoot)
    writeFileSync(join(firstPaths.queueDir, 'loop.pid'), processMarkerText(processMarker(process.pid)))
    writeFileSync(join(firstPaths.queueDir, 'run-branch.txt'), 'run/first\n')
    writeFileSync(join(firstPaths.queueDir, 'backlog.txt'), 'first:0\nsecond:1\n')
    await writeStatus(firstPaths, 'first-in-flight', 'running')

    const secondRepo = join(repoRoot, 'second-repository')
    mkdirSync(secondRepo)
    expect(spawnSync('git', ['init'], { cwd: secondRepo, windowsHide: true }).status).toBe(0)
    const secondPaths = orchPaths(secondRepo)
    writeFileSync(join(secondPaths.queueDir, 'run-branch.txt'), 'run/second\n')
    await writeStatus(secondPaths, 'second-completed', 'completed')
    await writeStatus(secondPaths, 'second-failed', 'failed')

    const firstRoot = git(['rev-parse', '--show-toplevel']).trim()
    const secondRoot = git(['rev-parse', '--show-toplevel'], secondRepo).trim()
    const result = spawnSync(
      process.execPath,
      [CLI, 'loop-status', '--repo', repoRoot, '--repo', secondRepo],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      `${firstRoot}: loop=running; run branch=run/first; queued=2; in flight=1`,
      `${secondRoot}: loop=not running; run branch=run/second; queued=0; in flight=2`,
    ])
  })
})

describe('fleet project selection', () => {
  function fleetFixture(): string {
    const fleet = realpathSync.native(mkdtempSync(join(tmpdir(), 'orch-cli-fleet-')))
    extraRoots.push(fleet)
    writeFileSync(join(fleet, 'fleet.json'), JSON.stringify({
      projects: {
        first: { repository: 'owner/first' },
        second: { repository: 'owner/second' },
      },
    }))
    writeFileSync(join(fleet, 'fleet.local.json'), JSON.stringify({
      projects: {
        first: { path: repoRoot },
        second: { path: join(fleet, 'missing-checkout') },
      },
    }))
    return fleet
  }

  function runCli(args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })
  }

  it('reports every fleet project and keeps state out of the checkout', () => {
    const fleet = fleetFixture()

    const result = runCli(['loop-status', '--fleet', fleet])

    expect(result.status).toBe(1)
    const lines = result.stdout.trim().split(/\r?\n/)
    expect(lines[0]).toBe('first: loop=not running; run branch=none; queued=0; in flight=0')
    expect(lines[1]).toMatch(/^second: unavailable; Project 'second' checkout '.*' is not a git repository\.$/)
    expect(existsSync(join(fleet, 'state', 'first', 'queue'))).toBe(true)
    expect(existsSync(join(repoRoot, 'orchestration'))).toBe(false)
  })

  it('runs a command for one named project', () => {
    const fleet = fleetFixture()

    const result = runCli(['queue', '--fleet', fleet, '--project', 'first'])

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(repoRoot, 'orchestration'))).toBe(false)
  })

  it('accepts the --fleet=<dir> and --project=<name> forms', () => {
    const fleet = fleetFixture()

    const result = runCli(['queue', `--fleet=${fleet}`, '--project=first'])

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(fleet, 'state', 'first', 'queue'))).toBe(true)
    expect(existsSync(join(repoRoot, 'orchestration'))).toBe(false)
  })

  it('resolves a relative --fleet from the caller\'s directory rather than the package', () => {
    const fleet = fleetFixture()

    const result = spawnSync(
      process.execPath,
      [CLI, 'queue', '--fleet', basename(fleet), '--project', 'first'],
      {
        cwd: repoRoot,
        env: { ...CORE_ENV, INIT_CWD: dirname(fleet) },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(fleet, 'state', 'first', 'queue'))).toBe(true)
  })

  it('treats --project=<name> as a project option rather than an argument', () => {
    const result = runCli(['loop-status', '--project=first'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no fleet.json found at or above')
  })

  it('rejects an empty --fleet= or --project= value', () => {
    const fleet = fleetFixture()

    const emptyFleet = runCli(['loop-status', '--fleet='])
    const emptyProject = runCli(['queue', '--fleet', fleet, '--project='])

    expect(emptyFleet.status).toBe(1)
    expect(emptyFleet.stderr).toContain('--fleet requires a value')
    expect(emptyProject.status).toBe(1)
    expect(emptyProject.stderr).toContain('--project requires a value')
  })

  it('refuses to mix a repository path with a fleet project', () => {
    const fleet = fleetFixture()

    const result = runCli(['loop-status', '--repo', repoRoot, '--fleet', fleet, '--project', 'first'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--repo cannot be combined with --fleet or --project')
  })

  it('requires a project for commands other than loop-status', () => {
    const fleet = fleetFixture()

    const result = runCli(['queue', '--fleet', fleet])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--fleet requires --project <name> for this command')
  })

  it('refuses to import issues without a fleet issue repository', () => {
    const fleet = fleetFixture()

    const fleetResult = runCli(['import-issues', '--fleet', fleet, '--project', 'first'])
    mkdirSync(join(repoRoot, 'orchestration'))
    const repositoryResult = runCli(['import-issues', '--repo', repoRoot])

    for (const result of [fleetResult, repositoryResult]) {
      expect(result.status).toBe(1)
      expect(result.stderr)
        .toContain('import-issues needs a fleet project whose fleet.json names an issueRepository')
    }
  })

  it('finds the project from the caller\'s directory when the environment names the fleet', () => {
    const fleet = fleetFixture()
    const caller = join(repoRoot, 'src')
    mkdirSync(caller)

    const result = spawnSync(process.execPath, [CLI, 'queue'], {
      cwd: fleet,
      env: { ...CORE_ENV, ORCHESTRATION_FLEET: fleet, INIT_CWD: caller },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(fleet, 'state', 'first', 'queue'))).toBe(true)
    expect(existsSync(join(repoRoot, 'orchestration'))).toBe(false)
  })

  it('installs the shared skills once per user for the fleet', () => {
    const fleet = fleetFixture()
    const home = join(fleet, 'home')
    mkdirSync(home)

    const result = spawnSync(process.execPath, [CLI, 'install-skills', '--fleet', fleet], {
      cwd: repoRoot,
      env: { ...CORE_ENV, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Installed: .claude/skills/git-commit')
    expect(result.stdout).toContain('Installed: .agents/skills/git-commit')
    expect(readFileSync(join(home, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toContain(`ORCHESTRATION_FLEET='${shellPathSpelling(fleet)}' npm run -C `)
  })

  it('installs the shared skills where each fleet project runner discovers them', () => {
    const fleet = fleetFixture()
    const home = join(fleet, 'home')
    mkdirSync(home)
    writeFileSync(join(repoRoot, 'external-runner.mjs'), [
      "import { join } from 'node:path'",
      'export const runner = {',
      '  sharedSkills: {',
      "    destinationRoot: (root) => join(root, '.external', 'skills'),",
      "    userDestinationRoot: (home) => join(home, '.external', 'skills'),",
      '    renderFile: (contents) => contents,',
      '  },',
      '  start: async () => process.pid,',
      '}',
      '',
    ].join('\n'))
    const runners = [['first', './external-runner.mjs'], ['second', 'claude']] as const
    for (const [project, runner] of runners) {
      mkdirSync(join(fleet, 'projects', project), { recursive: true })
      writeFileSync(join(fleet, 'projects', project, 'config.json'), JSON.stringify({ RUNNER: runner }))
    }

    const result = spawnSync(process.execPath, [CLI, 'install-skills', '--fleet', fleet], {
      cwd: fleet,
      env: { ...CORE_ENV, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Installed: .claude/skills/git-commit')
    expect(result.stdout).toContain('Installed: .external/skills/git-commit')
    expect(existsSync(join(home, '.agents', 'skills'))).toBe(false)
  })

  it('installs the shared skills for every agent a fleet project adapter declares', () => {
    const fleet = fleetFixture()
    const home = join(fleet, 'home')
    mkdirSync(home)
    const projectDirectory = join(fleet, 'projects', 'first', 'project')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(join(projectDirectory, 'project-first.ts'), [
      "import { join } from 'node:path'",
      'export const project = {',
      "  name: 'first',",
      '  sharedSkills: [{',
      "    destinationRoot: (root) => join(root, '.declared', 'skills'),",
      "    userDestinationRoot: (home) => join(home, '.declared', 'skills'),",
      '    renderFile: (contents) => contents,',
      '  }],',
      '  preCommitChecks: [],',
      "  pullRequest: { categories: [{ label: 'Changes' }], titleFallback: 'changes',",
      "    classifyCommit: () => ({ category: 'Changes' }), detectRisks: () => [] },",
      '  mergeChecks: () => [],',
      '  cycleSuite: () => [],',
      '}',
      '',
    ].join('\n'))

    const result = spawnSync(process.execPath, [CLI, 'install-skills', '--fleet', fleet], {
      cwd: fleet,
      env: { ...CORE_ENV, HOME: home, USERPROFILE: home, PROJECT: 'unrelated' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Installed: .claude/skills/git-commit')
    expect(result.stdout).toContain('Installed: .declared/skills/git-commit')
    expect(existsSync(join(home, '.declared', 'skills', 'loop-start', 'SKILL.md'))).toBe(true)
  })

  it('reports a fleet project adapter that fails to load and installs the others', () => {
    const fleet = fleetFixture()
    const home = join(fleet, 'home')
    mkdirSync(home)
    mkdirSync(join(fleet, 'projects', 'first', 'project'), { recursive: true })

    const result = spawnSync(process.execPath, [CLI, 'install-skills', '--fleet', fleet], {
      cwd: fleet,
      env: { ...CORE_ENV, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAIL: first: Could not discover project adapter')
    expect(result.stdout).toContain('Installed: .claude/skills/git-commit')
  })

  it('refuses --repo and --project for install-skills before installing', () => {
    const fleet = fleetFixture()
    const home = join(fleet, 'home')
    mkdirSync(home)
    mkdirSync(join(repoRoot, 'orchestration'))

    for (const args of [['--repo', repoRoot], ['--fleet', fleet, '--project', 'first']]) {
      const result = spawnSync(process.execPath, [CLI, 'install-skills', ...args], {
        cwd: repoRoot,
        env: { ...CORE_ENV, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('install-skills takes only --fleet <dir>')
    }
    expect(existsSync(join(home, '.claude', 'skills'))).toBe(false)
  })

  it('names the search start when no fleet manifest is found', () => {
    const result = runCli(['loop-status', '--project', 'first'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`no fleet.json found at or above ${repoRoot}`)
  })

  it('finds the fleet for --project from the caller\'s directory', () => {
    const fleet = fleetFixture()
    const caller = join(fleet, 'projects')
    mkdirSync(caller)

    const result = spawnSync(process.execPath, [CLI, 'queue', '--project', 'first'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, INIT_CWD: caller },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(fleet, 'state', 'first', 'queue'))).toBe(true)
    expect(existsSync(join(repoRoot, 'orchestration'))).toBe(false)
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

describe('delegate arguments', () => {
  it('rejects an unknown leading flag without creating or publishing a task', () => {
    const result = spawnSync(process.execPath, [CLI, 'delegate', '--hlep'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'true', FORGE: 'missing' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ERROR: unknown option: --hlep')
    expect(result.stderr).toContain(
      'Usage: delegate "<description>" [--effort minimal|low|medium|high] [--inspect]',
    )
    expect(result.stderr).not.toContain('Unknown FORGE')

    const paths = orchPaths(repoRoot, false)
    expect(readdirSync(paths.tasksDir)).toEqual([])
    expect(readdirSync(paths.queueDir)).toEqual([])
  })
})

describe('delegate outcomes', () => {
  const description = 'Repeat a decision that was already delegated once.'

  function delegate(): ReturnType<typeof spawnSync> & { stdout: string } {
    return spawnSync(process.execPath, [CLI, 'delegate', description], {
      cwd: repoRoot,
      env: { ...CORE_ENV, ISSUE_QUEUE_ENABLED: 'false' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })
  }

  function enqueuedId(stdout: string): string {
    const match = /^Enqueued: (\S+) \(depth=0\)$/m.exec(stdout)
    expect(match).not.toBeNull()
    return match![1]!
  }

  it('queues a fresh task when the indexed task already finished with no change', async () => {
    const paths = orchPaths(repoRoot)
    const first = delegate()
    expect(first.status).toBe(0)
    const firstId = enqueuedId(first.stdout)
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    await writeStatus(paths, firstId, 'no-change')

    const second = delegate()

    expect(second.status).toBe(0)
    const secondId = enqueuedId(second.stdout)
    expect(secondId).not.toBe(firstId)
    expect(secondId).toMatch(/_user-repeat-a-decision/)
    expect(second.stdout).toContain('Created: ')
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe(`${secondId}:0\n`)

    // The index now names the fresh task, so a third request while it is queued is a duplicate.
    const third = delegate()
    expect(third.stdout).toContain(`WARN: ${secondId} is already in the queue`)
  })

  it('warns instead of promising a start when the indexed task is running', async () => {
    const paths = orchPaths(repoRoot)
    const first = delegate()
    expect(first.status).toBe(0)
    const taskId = enqueuedId(first.stdout)
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    await writeStatus(paths, taskId, 'running')
    writeFileSync(join(paths.queueDir, 'loop.pid'), processMarkerText(processMarker(process.pid)))

    const second = delegate()

    expect(second.status).toBe(0)
    expect(second.stdout).toContain(`WARN: ${taskId} has already been processed or is running (status=running)`)
    expect(second.stdout).not.toContain('Enqueued:')
    expect(second.stdout).not.toContain('starts this task')
    expect(second.stdout).not.toContain('waits in the backlog')
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe('')
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

describe('manual task commands', () => {
  function runCli(args: string[], input?: string) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: repoRoot,
      env: CORE_ENV,
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })
  }

  it.each([
    ['new', 'Usage: new <task-id>'],
    ['enqueue', 'Usage: enqueue <task-id> [depth]'],
    ['start', 'Usage: start <task-id> [--effort minimal|low|medium|high] [--model <model>]'],
    ['logs', 'Usage: logs <task-id> [-f]'],
    ['merge', 'Usage: merge <task-id> [--yes] [--test-cmd "cmd"]'],
  ])('prints the usage of %s and fails without a task id', (command, usage) => {
    const result = runCli([command])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(usage + '\n')
  })

  it('creates a specification once and refuses to overwrite it', () => {
    const taskId = 'manual-new'
    const file = join(orchPaths(repoRoot).tasksDir, taskId + '.md')

    const created = runCli(['new', taskId])

    expect(created.status).toBe(0)
    expect(created.stdout).toBe(`Created: ${file}\n`)
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^# ${taskId}\n\n## Target Files\n`))

    writeFileSync(file, 'edited\n')
    const repeated = runCli(['new', taskId])

    expect(repeated.status).not.toBe(0)
    expect(repeated.stderr).toContain(`Task specification already exists: ${file}`)
    expect(readFileSync(file, 'utf8')).toBe('edited\n')
  })

  it('enqueues at depth 0 when the depth is not a non-negative integer', () => {
    const taskId = 'manual-enqueue'
    expect(runCli(['new', taskId]).status).toBe(0)

    const result = runCli(['enqueue', taskId, 'abc'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`Enqueued: ${taskId} (depth=0)\n`)
    expect(readFileSync(join(orchPaths(repoRoot).queueDir, 'backlog.txt'), 'utf8'))
      .toBe(`${taskId}:0\n`)
  })

  it('enqueues at the depth given', () => {
    const taskId = 'manual-enqueue-depth'
    expect(runCli(['new', taskId]).status).toBe(0)

    const result = runCli(['enqueue', taskId, '2'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`Enqueued: ${taskId} (depth=2)\n`)
    expect(readFileSync(join(orchPaths(repoRoot).queueDir, 'backlog.txt'), 'utf8'))
      .toBe(`${taskId}:2\n`)
  })

  it('rejects an unknown start option before creating a worktree', () => {
    const taskId = 'manual-start-option'
    expect(runCli(['new', taskId]).status).toBe(0)

    const result = runCli(['start', taskId, '--fast'])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Error: unknown option: --fast\n')
    expect(existsSync(worktreeDir(orchPaths(repoRoot), taskId))).toBe(false)
  })

  it.each([['extreme'], [undefined]])('rejects the start effort %j before creating a worktree', (effort) => {
    const taskId = 'manual-start-effort'
    expect(runCli(['new', taskId]).status).toBe(0)

    const result = runCli(['start', taskId, '--effort', ...(effort === undefined ? [] : [effort])])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Error: --effort must be minimal, low, medium or high\n')
    expect(existsSync(worktreeDir(orchPaths(repoRoot), taskId))).toBe(false)
  })

  it('fails the status of a task without a status record', () => {
    const result = runCli(['status', 'manual-unknown'])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Task not found: manual-unknown\n')
  })

  // A graceful stop leaves exactly this state; the next daemon, not status, classifies it.
  it('leaves a running task without a process record running while no loop runs', async () => {
    const paths = orchPaths(repoRoot)
    await writeStatus(paths, 'stopped-in-flight', 'running')

    const result = runCli(['status'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${'stopped-in-flight'.padEnd(20)} ${'running'.padEnd(10)} pid=\n`)
    expect(runCli(['status', 'stopped-in-flight']).stdout).toContain('running')
  })

  it('fails a running task without a process record while a loop runs', async () => {
    const paths = orchPaths(repoRoot)
    await writeStatus(paths, 'dead-in-flight', 'running')
    writeFileSync(join(paths.queueDir, 'loop.pid'), processMarkerText(processMarker(process.pid)))

    const result = runCli(['status', 'dead-in-flight'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${'dead-in-flight'.padEnd(20)} ${'failed'.padEnd(10)} pid=\n`)
  })

  it('reports that there are no tasks when none has a status record', () => {
    const result = runCli(['status'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('There are no running or completed tasks.\n')
  })

  it('prints an empty backlog followed by the status listing', () => {
    const result = runCli(['queue'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe([
      '=== Queue (backlog) ===',
      '  (empty)',
      '',
      '=== Task Status ===',
      'There are no running or completed tasks.',
      '',
    ].join('\n'))
  })

  it('prints each backlog entry with its depth', () => {
    const queueDir = orchPaths(repoRoot).queueDir
    mkdirSync(queueDir, { recursive: true })
    writeFileSync(join(queueDir, 'backlog.txt'), 'manual-first:0\nmanual-second:3\n')

    const result = runCli(['queue'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe([
      '=== Queue (backlog) ===',
      `  ${'manual-first'.padEnd(30)} depth=0`,
      `  ${'manual-second'.padEnd(30)} depth=3`,
      '',
      '=== Task Status ===',
      'There are no running or completed tasks.',
      '',
    ].join('\n'))
  })

  it('fails a missing log', () => {
    const log = join(orchPaths(repoRoot).logsDir, 'manual-no-log.log')

    const result = runCli(['logs', 'manual-no-log'])

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`Log not found: ${log}\n`)
  })

  it.each(['n\n', '\n', 'yes\n'])('aborts a merge without --yes on the answer %j', (answer) => {
    const result = runCli(['merge', 'manual-merge-declined'], answer)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      'Merge task/manual-merge-declined into the current branch? [y/N] Aborted.\n',
    )
    expect(result.stderr).toBe('')
  })

  it.each(['y\n', 'Y\n'])('proceeds with a merge without --yes on the answer %j', (answer) => {
    const result = runCli(['merge', 'manual-merge-accepted'], answer)

    expect(result.stdout).toBe(
      'Merge task/manual-merge-accepted into the current branch? [y/N] Merging manual-merge-accepted\n',
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('Task not found: manual-merge-accepted\n')
  })

  it('rejects an unknown merge option before asking', () => {
    const result = runCli(['merge', 'manual-merge-option', '--force'], 'y\n')

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Unknown option: --force\n')
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
    recordIssuesForTask(paths, taskId, [197])
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '3\n')
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
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
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

  it('preserves the merge failure streak for a no-change outcome', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20260814_180935_082_user-no-change'
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFileSync(finalMessageFile(paths, taskId),
      'The requested behavior is already present.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    await writeStatus(paths, taskId, 'completed')
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '3\n')

    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('3\n')
  })

  it('records durable completion for a linked no-change outcome', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20260815_074127_029_user-linked-no-change'
    const issueNumber = 218
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFileSync(finalMessageFile(paths, taskId),
      'The requested behavior is already present.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    await writeStatus(paths, taskId, 'completed')
    recordIssuesForTask(paths, taskId, [issueNumber])

    let issueState: 'open' | 'closed' = 'open'
    const forge = {
      issueClosingCommitMessage: (message: string) => message,
      getIssue: async () => ({
        number: issueNumber,
        state: issueState,
        title: 'Linked task',
        body: '',
        author: { login: 'maintainer', hasWriteAccess: true },
        labels: [],
        assignees: [],
        updatedAt: '2026-08-15T00:00:00Z',
      }),
      closeIssue: async () => { issueState = 'closed' },
      removeLabel: async () => {},
    }
    vi.doMock('../src/adapters/forge.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/adapters/forge.ts')>(),
      loadForge: async () => forge,
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
    try {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV)
      process.argv = [process.execPath, CLI, 'merge', taskId, '--yes']

      await import('../src/cli.ts')

      expect(process.exitCode).toBe(0)
      expect(issueState).toBe('closed')
      expect(issueCompletionForIssue(paths, issueNumber)).toEqual({
        taskId, issueNumber, outcome: 'no-change',
      })
    } finally {
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      vi.doUnmock('../src/adapters/forge.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
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

  it('rejects --test-cmd without a command instead of falling back to TEST_CMD', () => {
    const result = spawnSync(process.execPath, [CLI, 'merge', 'missing-test-cmd', '--yes', '--test-cmd'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, TEST_CMD: 'node -e "process.exit(0)"' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Usage: merge <task-id> [--yes] [--test-cmd "cmd"]\n')
  })
})

describe('manually promoted run ending', () => {
  it('records a Completed Loop event and the LOOP_DONE marker', () => {
    const paths = orchPaths(repoRoot)
    mkdirSync(paths.queueDir, { recursive: true })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '12\n')
    writeFileSync(join(paths.queueDir, 'cycle-cap.txt'), '12\n')

    const result = spawnSync(process.execPath, [CLI, 'shipped', '#322'], {
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
      .toBe('LOOP_DONE: #322\n')
  })

  it('normalizes a zero-padded pull request number', () => {
    const paths = orchPaths(repoRoot)

    const result = spawnSync(process.execPath, [CLI, 'shipped', '007'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Recorded: Completed Loop PR #7')
    expect(readFileSync(join(paths.logsDir, 'loop-markers.log'), 'utf8'))
      .toBe('LOOP_DONE: #7\n')
  })

  it('falls back to its configured cycle cap when no daemon cap was recorded', () => {
    const paths = orchPaths(repoRoot)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '5\n')

    const result = spawnSync(
      process.execPath,
      [CLI, 'shipped', 'HTTPS://EXAMPLE.TEST:443/pull/323'],
      {
        cwd: repoRoot,
        env: { ...INHERITED_ENV, MAX_SCAN_CYCLES: '8' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: CLI_TIMEOUT_MS,
      },
    )

    expect(result.status).toBe(0)
    expect(readFileSync(join(paths.logsDir, 'loop.log'), 'utf8')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[loop 05\/08\] Completed {2}Loop {8}PR https:\/\/example\.test\/pull\/323\r?\n$/,
    )
    expect(readFileSync(join(paths.logsDir, 'loop-markers.log'), 'utf8'))
      .toBe('LOOP_DONE: https://example.test/pull/323\n')
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

  it.each([
    '0', '#0', '-12', 'not-a-pr', '/pull/12', 'ftp://example.test/pull/12', 'https://',
    'https:example.test/pull/12',
  ])('rejects invalid pull request reference %s', (reference) => {
    const result = spawnSync(process.execPath, [CLI, 'shipped', reference], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'must be a positive PR number or absolute HTTP(S) URL',
    )
  })

  it('rejects URL control-character injection without writing a marker', () => {
    const paths = orchPaths(repoRoot)
    const injected = 'https://example.test/pull/323\r\nLOOP_DONE: https://attacker.test/pull/1\t'
    const result = spawnSync(process.execPath, [CLI, 'shipped', injected], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must be a positive PR number or absolute HTTP(S) URL')
    expect(existsSync(join(paths.logsDir, 'loop-markers.log'))).toBe(false)
  })
})
