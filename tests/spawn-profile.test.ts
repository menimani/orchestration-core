import * as childProcess from 'node:child_process'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SPAWN_PROFILE_VARIABLE, describeInvocation, profileChildProcesses, recordSpawnProfile,
  type SpawnProfileFile, type SpawnRecord,
} from './spawnProfile.ts'

const repository = join(import.meta.dirname, '..')
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function fixtureDirectory(prefix: string): string {
  const fixture = mkdtempSync(join(tmpdir(), prefix))
  fixtures.push(fixture)
  return fixture
}

function gitRepository(): string {
  const directory = fixtureDirectory('orch-spawn-profile-git-')
  execFileSync('git', ['init', '-q', directory], { stdio: 'ignore' })
  return directory
}

function waitForClose(child: childProcess.ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
}

// A copy of the module's functions, so a test wraps its own object rather than the
// worker's child_process module, which a profiled run has already wrapped.
function childProcessFunctions(): Record<string | symbol, unknown> {
  const { spawn: s, spawnSync: ss, execFile, execFileSync: efs, exec, execSync, fork } = childProcess
  return { spawn: s, spawnSync: ss, execFile, execFileSync: efs, exec, execSync, fork }
}

function invocations(records: readonly SpawnRecord[]): Pick<SpawnRecord, 'executable' | 'subcommand' | 'exited'>[] {
  return records.map(({ executable, subcommand, exited }) => ({ executable, subcommand, exited }))
}

// The 1-based number of the line in a repository file that ends with `marker`.
function lineEndingWith(file: string, marker: string): number {
  const lines = readFileSync(join(repository, file), 'utf8').split(/\r?\n/)
  const index = lines.findIndex((line) => line.trimEnd().endsWith(marker))
  if (index < 0) throw new Error(`no line of ${file} ends with ${marker}`)
  return index + 1
}

function callers(records: readonly SpawnRecord[]): Pick<SpawnRecord, 'executable' | 'subcommand' | 'caller' | 'via'>[] {
  return records.map(({ executable, subcommand, caller, via }) => ({ executable, subcommand, caller, via }))
}

function runNode(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null, output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, output }))
  })
}

describe('spawn profile invocations', () => {
  it('names the executable and the subcommand of each kind of call', () => {
    expect(describeInvocation('spawn', ['C:\\Program Files\\Git\\cmd\\git.exe', ['-C', 'repo', '-c', 'a=b', 'rev-parse', 'HEAD']]))
      .toEqual({ executable: 'git', subcommand: 'rev-parse' })
    expect(describeInvocation('execFileSync', ['/usr/bin/git', ['commit', '-m', 'x'], { cwd: 'repo' }]))
      .toEqual({ executable: 'git', subcommand: 'commit' })
    expect(describeInvocation('spawnSync', ['/usr/local/bin/node', ['/tmp/fixture/scripts/run-tests.mjs']]))
      .toEqual({ executable: 'node', subcommand: 'run-tests.mjs' })
    expect(describeInvocation('execFile', ['powershell.exe', ['-NoProfile', '-Command', 'Get-Date']]))
      .toEqual({ executable: 'powershell', subcommand: '-NoProfile' })
    expect(describeInvocation('spawn', ['cmd.exe', ['/d', '/c', 'echo']]))
      .toEqual({ executable: 'cmd', subcommand: '/d' })
    expect(describeInvocation('spawn', ['cmd.exe', ['/d /s /c "node C:\\fixture\\echo.js"'], { windowsVerbatimArguments: true }]))
      .toEqual({ executable: 'cmd', subcommand: '/d' })
    expect(describeInvocation('spawn', ['taskkill', ['/PID', '1']]))
      .toEqual({ executable: 'taskkill', subcommand: null })
    expect(describeInvocation('exec', ['"C:\\Program Files\\Git\\cmd\\git.exe" status --short']))
      .toEqual({ executable: 'git', subcommand: 'status' })
    expect(describeInvocation('execSync', ['git log -1']))
      .toEqual({ executable: 'git', subcommand: 'log' })
    expect(describeInvocation('spawn', ['git push origin', [], { shell: true }]))
      .toEqual({ executable: 'git', subcommand: 'push' })
    expect(describeInvocation('fork', ['/tmp/fixture/worker.mjs', ['--flag']]))
      .toEqual({ executable: 'node', subcommand: 'worker.mjs' })
  })
})

describe('spawn profile recorder', () => {
  it('wraps nothing and writes nothing while the variable is unset', () => {
    const before = childProcessFunctions()

    recordSpawnProfile({})
    recordSpawnProfile({ [SPAWN_PROFILE_VARIABLE]: '' })

    expect(childProcessFunctions()).toEqual(before)
    for (const name of Object.keys(before)) expect(childProcessFunctions()[name], name).toBe(before[name])
  })

  it('records a spawn, a spawnSync and an execFileSync with their subcommands and durations', async () => {
    const target = childProcessFunctions()
    const recorder = profileChildProcesses(target)
    const git = gitRepository()

    const child = (target.spawn as typeof spawn)('git', ['-C', git, 'status', '--short'], { stdio: 'ignore' })
    expect(await waitForClose(child)).toBe(0)
    const sync = (target.spawnSync as typeof spawnSync)(process.execPath, ['-e', 'process.exit(3)'])
    expect(sync.status).toBe(3)
    const gitDirectory = (target.execFileSync as typeof execFileSync)('git', ['-C', git, 'rev-parse', '--git-dir'], { encoding: 'utf8' })
    expect(gitDirectory.trim()).toBe('.git')

    const records = recorder.records()
    expect(invocations(records)).toEqual([
      { executable: 'git', subcommand: 'status', exited: true },
      { executable: 'node', subcommand: '-e', exited: true },
      { executable: 'git', subcommand: 'rev-parse', exited: true },
    ])
    for (const record of records) expect(record.durationMs).toBeGreaterThan(0)
  })

  it('records a failing child and throws the same error the unwrapped call throws', () => {
    const target = childProcessFunctions()
    const recorder = profileChildProcesses(target)
    const git = gitRepository()
    const args = ['-C', git, 'rev-parse', '--verify', 'refs/heads/missing']

    const unwrapped = (() => {
      try {
        execFileSync('git', args, { stdio: 'pipe' })
      } catch (error) {
        return error as { status: number, stderr: Buffer }
      }
      throw new Error('the unwrapped call succeeded')
    })()
    let wrapped: { status: number, stderr: Buffer } | undefined
    try {
      (target.execFileSync as typeof execFileSync)('git', args, { stdio: 'pipe' })
    } catch (error) {
      wrapped = error as { status: number, stderr: Buffer }
    }

    expect(wrapped).toBeInstanceOf(Error)
    expect(wrapped?.status).toBe(unwrapped.status)
    expect(wrapped?.stderr.toString()).toBe(unwrapped.stderr.toString())
    expect(invocations(recorder.records())).toEqual([{ executable: 'git', subcommand: 'rev-parse', exited: true }])
    expect(recorder.records()[0]!.durationMs).toBeGreaterThan(0)
  })

  it('returns, throws and forwards exactly what the wrapped function does', () => {
    const returned = { child: 'sentinel' }
    const thrown = new Error('spawn refused')
    const receivers: unknown[] = []
    const target: Record<string | symbol, unknown> = {
      spawnSync(this: unknown) {
        receivers.push(this)
        return returned
      },
      execFileSync() {
        throw thrown
      },
    }
    const recorder = profileChildProcesses(target)

    expect((target.spawnSync as () => unknown).call(target)).toBe(returned)
    expect(receivers).toEqual([target])
    expect(() => (target.execFileSync as () => unknown)()).toThrow(thrown)
    expect((target.spawnSync as () => unknown).name).toBe('spawnSync')
    expect(invocations(recorder.records())).toHaveLength(2)
  })

  it('lets the wrapped call reject arguments it cannot describe', () => {
    const target = childProcessFunctions()
    const recorder = profileChildProcesses(target)
    const thrownBy = (call: () => unknown): { name: string, message: string, code: unknown } => {
      try {
        call()
      } catch (error) {
        const { name, message, code } = error as Error & { code?: unknown }
        return { name, message, code }
      }
      throw new Error('the call accepted the file')
    }

    // Not a string, and one the profile cannot turn into one either.
    const file = { toString: () => { throw new Error('no text') } }

    const unwrapped = thrownBy(() => spawnSync(file as unknown as string))
    expect(thrownBy(() => (target.spawnSync as (file: unknown) => unknown)(file))).toEqual(unwrapped)
    expect(unwrapped).toMatchObject({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' })
    expect(invocations(recorder.records())).toEqual([{ executable: 'unknown', subcommand: null, exited: true }])
  })

  it('counts a call one wrapped function makes into another once', () => {
    const target: Record<string | symbol, unknown> = {
      execFileSync: () => 'output',
      execSync: (command: string) => (target.execFileSync as (file: string) => unknown)(command),
    }
    const recorder = profileChildProcesses(target)

    expect((target.execSync as (command: string) => unknown)('git status')).toBe('output')

    expect(invocations(recorder.records())).toEqual([{ executable: 'git', subcommand: 'status', exited: true }])
  })

  it('keeps the promisified execFile and records the child it starts', async () => {
    const target = childProcessFunctions()
    const recorder = profileChildProcesses(target)
    const git = gitRepository()

    const result = await promisify(target.execFile as typeof childProcess.execFile)('git', ['-C', git, 'rev-parse', '--git-dir'])

    expect(result).toEqual({ stdout: expect.stringMatching(/^\.git\r?\n$/), stderr: '' })
    expect(invocations(recorder.records())).toEqual([{ executable: 'git', subcommand: 'rev-parse', exited: true }])
  })

  it('wraps a module once and starts a fresh record on reset', async () => {
    const target = childProcessFunctions()
    const recorder = profileChildProcesses(target)
    const wrapped = target.spawn
    expect(profileChildProcesses(target)).toBe(recorder)
    expect(target.spawn).toBe(wrapped)

    const child = (target.spawn as typeof spawn)(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' })
    expect(invocations(recorder.records())).toEqual([{ executable: 'node', subcommand: '-e', exited: false }])
    recorder.reset()
    await waitForClose(child)

    // A child of the previous file that outlived it is no part of the next file's record.
    expect(recorder.records()).toEqual([])
  })

  it('attributes a direct spawn to the line of the test that made it', () => {
    const target = childProcessFunctions()
    const recorder = profileChildProcesses(target)

    const result = (target.spawnSync as typeof spawnSync)(process.execPath, ['-e', '']) // spawned directly
    expect(result.status).toBe(0)

    const line = lineEndingWith('tests/spawn-profile.test.ts', '// spawned directly')
    expect(callers(recorder.records())).toEqual([
      { executable: 'node', subcommand: '-e', caller: `tests/spawn-profile.test.ts:${line}`, via: null },
    ])
  })

  it('attributes a spawn made through a local helper to the helper, with no frame outside this file', () => {
    const target = childProcessFunctions()
    const recorder = profileChildProcesses(target)
    const git = gitRepository()
    const gitDirectory = (args: string[]): string => (
      (target.execFileSync as typeof execFileSync)('git', ['-C', git, ...args], { encoding: 'utf8' }) // spawned by the helper
    )

    expect(gitDirectory(['rev-parse', '--git-dir']).trim()).toBe('.git')

    const line = lineEndingWith('tests/spawn-profile.test.ts', '// spawned by the helper')
    expect(callers(recorder.records())).toEqual([
      { executable: 'git', subcommand: 'rev-parse', caller: `tests/spawn-profile.test.ts:${line}`, via: null },
    ])
  })

  it('records the arguments, directory, order and test of each child', () => {
    const target = childProcessFunctions()
    const recorder = profileChildProcesses(target)
    const git = gitRepository()

    recorder.startTest('outer > asks twice')
    ;(target.execFileSync as typeof execFileSync)('git', ['rev-parse', '--git-dir'], { cwd: git, stdio: 'ignore' })
    recorder.startTest(null)
    ;(target.spawnSync as typeof spawnSync)(process.execPath, ['-e', ''])

    expect(recorder.records().map(({ executable, argv, cwd, test, sequence }) => ({ executable, argv, cwd, test, sequence }))).toEqual([
      { executable: 'git', argv: ['rev-parse', '--git-dir'], cwd: git, test: 'outer > asks twice', sequence: 0 },
      { executable: 'node', argv: ['-e', ''], cwd: process.cwd(), test: null, sequence: 1 },
    ])
  })
})

describe('spawn profile in a test run', () => {
  // Runs a probe file through Vitest with the repository's setup file, as the suite does.
  function writeProbe(fixture: string): void {
    writeFileSync(join(fixture, 'vitest.config.mjs'), [
      'export default {',
      '  test: {',
      '    globals: true,',
      "    include: ['probe.test.mjs'],",
      `    setupFiles: [${JSON.stringify(join(repository, 'tests', 'gitIsolation.ts'))}],`,
      '  },',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(fixture, 'probe.test.mjs'), [
      "import { execFileSync, spawn, spawnSync } from 'node:child_process'",
      "import { createRequire } from 'node:module'",
      "const probedRepository = process.env.PROBE_REPOSITORY",
      "it('starts children', async () => {",
      "  const wrapped = Object.getOwnPropertySymbols(createRequire(import.meta.url)('node:child_process')).length > 0",
      "  expect(wrapped).toBe(process.env.PROBE_EXPECT_WRAPPED === '1')",
      "  const child = spawn('git', ['-C', probedRepository, 'status'], { stdio: 'ignore' })",
      "  await new Promise((resolve) => child.once('close', resolve))",
      "  expect(spawnSync(process.execPath, ['-e', '']).status).toBe(0)",
      "  expect(execFileSync('git', ['-C', probedRepository, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()).toBe('.git')",
      "})",
      "it('sees a failing child throw', () => {",
      "  expect(() => execFileSync('git', ['-C', probedRepository, 'rev-parse', '--verify', 'refs/heads/missing'], { stdio: 'pipe' }))",
      "    .toThrow(/Command failed: git -C .* rev-parse --verify refs\\/heads\\/missing/)",
      "})",
      '',
    ].join('\n'))
  }

  function probeEnvironment(git: string, expectWrapped: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PROBE_REPOSITORY: git, PROBE_EXPECT_WRAPPED: expectWrapped ? '1' : '0' }
    delete env[SPAWN_PROFILE_VARIABLE]
    return env
  }

  const vitest = join(repository, 'node_modules', 'vitest', 'vitest.mjs')

  it('writes one record per test file while the variable names a directory', async () => {
    const fixture = fixtureDirectory('orch-spawn-profile-run-')
    const profile = join(fixture, 'profile')
    const git = gitRepository()
    writeProbe(fixture)

    const result = await runNode([vitest, 'run'], fixture, {
      ...probeEnvironment(git, true),
      [SPAWN_PROFILE_VARIABLE]: profile,
    })

    expect(result.status, result.output).toBe(0)
    expect(readdirSync(profile)).toEqual(['probe.test.mjs.json'])
    const record = JSON.parse(readFileSync(join(profile, 'probe.test.mjs.json'), 'utf8')) as SpawnProfileFile
    expect(record).toMatchObject({ file: 'probe.test.mjs', project: '', tests: 2 })
    expect(record.durationMs).toBeGreaterThan(0)
    expect(invocations(record.spawns)).toEqual([
      { executable: 'git', subcommand: 'status', exited: true },
      { executable: 'node', subcommand: '-e', exited: true },
      { executable: 'git', subcommand: 'rev-parse', exited: true },
      { executable: 'git', subcommand: 'rev-parse', exited: true },
    ])
    for (const spawned of record.spawns) expect(spawned.durationMs).toBeGreaterThan(0)
  })

  it('attributes a child a module under src/ starts to its git wrapper and to the test that called into the module', async () => {
    const fixture = fixtureDirectory('orch-spawn-profile-caller-')
    const profile = join(fixture, 'profile')
    const git = gitRepository()
    writeProbe(fixture)
    // The same configuration with a probe that asks a module under src/ instead.
    writeFileSync(join(fixture, 'probe.test.mjs'), [
      `import { remoteForBaseRef } from ${JSON.stringify(join(repository, 'src', 'gitRemote.ts').replace(/\\/g, '/'))}`,
      "it('asks a module', () => {",
      "  expect(remoteForBaseRef(process.env.PROBE_REPOSITORY, 'origin/main')).toBeUndefined()",
      "})",
      '',
    ].join('\n'))

    const result = await runNode([vitest, 'run'], fixture, {
      ...probeEnvironment(git, true),
      [SPAWN_PROFILE_VARIABLE]: profile,
    })

    expect(result.status, result.output).toBe(0)
    const record = JSON.parse(readFileSync(join(profile, 'probe.test.mjs.json'), 'utf8')) as SpawnProfileFile
    const wrapperLine = lineEndingWith('src/gitRemote.ts', "return execFileSync('git', args, {")
    expect(record.spawns.map(({ executable, subcommand, caller, via, test, argv, cwd }) => ({ executable, subcommand, caller, via, test, argv, cwd }))).toEqual([{
      executable: 'git',
      subcommand: 'remote',
      caller: `src/gitRemote.ts:${wrapperLine}`,
      via: `${realpathSync(fixture).replace(/\\/g, '/')}/probe.test.mjs:3`,
      test: 'asks a module',
      argv: ['remote'],
      cwd: git,
    }])
  })

  it('leaves child_process unwrapped and writes nothing while the variable is unset', async () => {
    const fixture = fixtureDirectory('orch-spawn-profile-off-')
    const git = gitRepository()
    writeProbe(fixture)
    const before = readdirSync(fixture).sort()

    const result = await runNode([vitest, 'run'], fixture, probeEnvironment(git, false))

    expect(result.status, result.output).toBe(0)
    expect(readdirSync(fixture).filter((name) => name !== 'node_modules').sort()).toEqual(before)
  })
})

describe('spawn profile report', () => {
  function spawnRecord(executable: string, subcommand: string | null, durationMs: number): SpawnRecord {
    return { executable, subcommand, durationMs, exited: true }
  }

  it('totals the recorded files and tables them by command and by file', async () => {
    const profile = fixtureDirectory('orch-spawn-profile-report-')
    const files: SpawnProfileFile[] = [
      {
        file: 'tests/heavy.test.ts',
        project: 'parallel',
        tests: 2,
        durationMs: 4000,
        spawns: [
          spawnRecord('git', 'commit', 1500),
          spawnRecord('git', 'commit', 500),
          spawnRecord('git', 'rev-parse', 200),
          spawnRecord('node', 'cli.ts', 800),
        ],
      },
      {
        file: 'tests/light.test.ts',
        project: 'sequential',
        tests: 4,
        durationMs: 1000,
        spawns: [spawnRecord('git', 'rev-parse', 100), spawnRecord('taskkill', null, 400)],
      },
      { file: 'tests/pure.test.ts', project: 'parallel', tests: 3, durationMs: 50, spawns: [] },
    ]
    mkdirSync(profile, { recursive: true })
    for (const file of files) writeFileSync(join(profile, `${file.file.replace(/\//g, '_')}.json`), `${JSON.stringify(file)}\n`)
    writeFileSync(join(profile, 'notes.txt'), 'not a record\n')

    const result = await runNode([join(repository, 'scripts', 'test-spawn-profile.mjs'), profile], repository, process.env)

    expect(result.status, result.output).toBe(0)
    expect(result.output.trimEnd().split(/\r?\n/)).toEqual([
      `Spawn profile of 3 test files in ${profile}`,
      'Counts the child processes each test worker created through node:child_process.',
      'Processes started by a child CLI are outside the worker and are not counted.',
      'Child wall time adds up overlapping children, so a share above 100% is possible.',
      '',
      'Total spawns: 6',
      'Total child wall time: 3.5s',
      '',
      'By executable and subcommand',
      'executable  subcommand  count  total    mean',
      'git         commit          2   2.0s  1000ms',
      'node        cli.ts          1   0.8s   800ms',
      'taskkill    -               1   0.4s   400ms',
      'git         rev-parse       2   0.3s   150ms',
      '',
      'By test file',
      'test file            tests  spawns  spawns/test  child time  share of file',
      'tests/heavy.test.ts      2       4          2.0        3.0s            75%',
      'tests/light.test.ts      4       2          0.5        0.5s            50%',
      'tests/pure.test.ts       3       0          0.0        0.0s             0%',
      '',
      'Most spawns per test (top 20)',
      'test file            tests  spawns  spawns/test  child time  share of file',
      'tests/heavy.test.ts      2       4          2.0        3.0s            75%',
      'tests/light.test.ts      4       2          0.5        0.5s            50%',
      'tests/pure.test.ts       3       0          0.0        0.0s             0%',
      '',
      'By origin of the caller',
      'origin               spawns  child time  share',
      'src/                      0        0.0s     0%',
      'shared test helpers       0        0.0s     0%',
      'test files                0        0.0s     0%',
      'other                     6        3.5s   100%',
      '',
      'Call sites with the most child wall time (top 40)',
      'caller  via  executable  subcommand  count  total    mean',
      '-       -    git         commit          2   2.0s  1000ms',
      '-       -    node        cli.ts          1   0.8s   800ms',
      '-       -    taskkill    -               1   0.4s   400ms',
      '-       -    git         rev-parse       2   0.3s   150ms',
      '',
      'Repeated git questions (top 40 call sites)',
      'A git child with the same arguments and directory as the git child just before it in the same test.',
      'Repeated: 0 spawns, 0.0s',
      'caller  via  subcommand  repeats  total',
    ])
  })

  it('totals spawns by the origin of their caller, by call site, and by repeated git question', async () => {
    const profile = fixtureDirectory('orch-spawn-profile-callers-')
    const gitQuestion = (
      sequence: number, test: string | null, cwd: string, argv: string[], durationMs: number, caller: string | null, via: string | null,
    ): SpawnRecord => ({
      executable: 'git', subcommand: argv[0]!, durationMs, exited: true, argv, cwd, caller, via, test, sequence,
    })
    const head = ['rev-parse', 'HEAD']
    const file: SpawnProfileFile = {
      file: 'tests/asks.test.ts',
      project: 'parallel',
      tests: 2,
      durationMs: 3000,
      // Out of start order, as children that exit in a different order are recorded.
      spawns: [
        gitQuestion(1, 'asks twice', '/r', head, 120, 'src/git.ts:4', 'src/merge.ts:10'),
        gitQuestion(0, 'asks twice', '/r', head, 100, 'src/git.ts:4', 'src/merge.ts:10'),
        gitQuestion(2, 'asks twice', '/r', ['commit', '-m', 'x'], 300, 'tests/loopHarness.ts:20', 'tests/asks.test.ts:5'),
        gitQuestion(3, 'asks twice', '/r', head, 140, 'src/git.ts:4', 'src/merge.ts:10'),
        gitQuestion(4, 'asks elsewhere', '/r', head, 50, 'tests/asks.test.ts:30', null),
        gitQuestion(5, 'asks elsewhere', '/other', head, 60, 'tests/asks.test.ts:32', null),
        {
          executable: 'node', subcommand: 'cli.ts', durationMs: 200, exited: true,
          argv: ['cli.ts'], cwd: '/other', caller: 'tests/asks.test.ts:31', via: null, test: 'asks elsewhere', sequence: 6,
        },
        gitQuestion(7, 'asks elsewhere', '/other', head, 70, 'tests/asks.test.ts:32', null),
        { executable: 'node', subcommand: '-e', durationMs: 400, exited: true },
      ],
    }
    writeFileSync(join(profile, 'tests_asks.test.ts.json'), `${JSON.stringify(file)}\n`)

    const result = await runNode([join(repository, 'scripts', 'test-spawn-profile.mjs'), profile], repository, process.env)

    expect(result.status, result.output).toBe(0)
    const lines = result.output.trimEnd().split(/\r?\n/)
    expect(lines.slice(5, 7)).toEqual(['Total spawns: 9', 'Total child wall time: 1.4s'])
    expect(lines.slice(lines.indexOf('By origin of the caller'))).toEqual([
      'By origin of the caller',
      'origin               spawns  child time  share',
      'src/                      3        0.4s    25%',
      'shared test helpers       1        0.3s    21%',
      'test files                4        0.4s    26%',
      'other                     1        0.4s    28%',
      '',
      'Call sites with the most child wall time (top 40)',
      'caller                   via                   executable  subcommand  count  total   mean',
      '-                        -                     node        -e              1   0.4s  400ms',
      'src/git.ts:4             src/merge.ts:10       git         rev-parse       3   0.4s  120ms',
      'tests/loopHarness.ts:20  tests/asks.test.ts:5  git         commit          1   0.3s  300ms',
      'tests/asks.test.ts:31    -                     node        cli.ts          1   0.2s  200ms',
      'tests/asks.test.ts:32    -                     git         rev-parse       2   0.1s   65ms',
      'tests/asks.test.ts:30    -                     git         rev-parse       1   0.1s   50ms',
      '',
      'Repeated git questions (top 40 call sites)',
      'A git child with the same arguments and directory as the git child just before it in the same test.',
      // The second rev-parse of each test repeats the first; the one after the commit and
      // the one in another directory do not, and a node child in between breaks nothing.
      'Repeated: 2 spawns, 0.2s',
      'caller                 via              subcommand  repeats  total',
      'src/git.ts:4           src/merge.ts:10  rev-parse         1   0.1s',
      'tests/asks.test.ts:32  -                rev-parse         1   0.1s',
    ])
    const originCounts = lines.slice(lines.indexOf('By origin of the caller') + 2, lines.indexOf('By origin of the caller') + 6)
      .map((line) => Number(/\s(\d+)\s+\d+\.\ds/.exec(line)![1]))
    expect(originCounts.reduce((sum, count) => sum + count, 0)).toBe(9)
  })

  it('exits with usage when no directory is named', async () => {
    const result = await runNode([join(repository, 'scripts', 'test-spawn-profile.mjs')], repository, process.env)

    expect(result.status).toBe(2)
    expect(result.output).toBe('Usage: node scripts/test-spawn-profile.mjs <directory>\n')
  })
})
