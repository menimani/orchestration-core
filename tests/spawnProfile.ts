import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join, win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { afterAll, type RunnerTestFile, type RunnerTestSuite } from 'vitest'

// An opt-in record of every child process a test file creates in its worker, so the
// suite's cost can be traced to the processes it starts. It is off unless this variable
// names a directory; off, nothing is wrapped, recorded or written.
export const SPAWN_PROFILE_VARIABLE = 'ORCH_TEST_SPAWN_PROFILE'

export interface SpawnRecord {
  executable: string
  subcommand: string | null
  durationMs: number
  // False for a child still running when its test file finished; its duration then runs
  // to that moment.
  exited: boolean
}

export interface SpawnProfileFile {
  file: string
  project: string
  tests: number
  durationMs: number
  spawns: SpawnRecord[]
}

export interface SpawnRecorder {
  records(): SpawnRecord[]
  reset(): void
}

type Mode = 'sync' | 'child' | 'promise'

const PROFILED_FUNCTIONS: Record<string, Mode> = {
  spawn: 'child',
  spawnSync: 'sync',
  execFile: 'child',
  execFileSync: 'sync',
  exec: 'child',
  execSync: 'sync',
  fork: 'child',
}
// The executables whose first argument decides what the process does, so `git rev-parse`
// and `git commit` are counted apart.
const SUBCOMMAND_EXECUTABLES = new Set(['git', 'node', 'powershell', 'cmd'])
// Git options that take their value as the next argument.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c'])
// Shared by every module instance in a worker, because the worker keeps one
// child_process module while each test file loads this helper afresh.
const RECORDER = Symbol.for('orchestration.spawnProfile')

// The base name a profile groups by: `git.exe`, `/usr/bin/git` and `git` are one row.
export function executableName(command: string): string {
  return win32.basename(command).replace(/\.exe$/i, '').toLowerCase()
}

// Splits a shell command line at whitespace outside double quotes. It only has to find
// the executable and its first argument, not reproduce a shell's parsing.
function commandLineWords(commandLine: string): string[] {
  return [...commandLine.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '')
}

function subcommandOf(executable: string, argv: readonly string[]): string | null {
  if (!SUBCOMMAND_EXECUTABLES.has(executable)) return null
  if (executable === 'git') {
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index]!
      if (GIT_VALUE_OPTIONS.has(argument)) index += 1
      else if (!argument.startsWith('-')) return argument
    }
    return null
  }
  const first = argv[0]
  if (first === undefined) return null
  // A script path names the script, not the temporary directory a fixture put it in.
  if (executable === 'node') return /[\\/]/.test(first) ? win32.basename(first) : first
  // A verbatim cmd argument may hold a whole command line; its first switch is the row.
  return first.trim().split(/\s+/)[0] ?? first
}

// Which executable and subcommand a call to one of the profiled functions starts.
export function describeInvocation(name: string, args: readonly unknown[]): Pick<SpawnRecord, 'executable' | 'subcommand'> {
  let words: string[]
  if (name === 'exec' || name === 'execSync') {
    words = commandLineWords(String(args[0]))
  } else {
    const argumentList = Array.isArray(args[1]) ? args[1].map(String) : []
    const options = (Array.isArray(args[1]) ? args[2] : args[1]) as { execPath?: unknown, shell?: unknown } | undefined
    if (name === 'fork') {
      const execPath = typeof options?.execPath === 'string' ? options.execPath : process.execPath
      words = [execPath, String(args[0]), ...argumentList]
    } else {
      const file = String(args[0])
      words = options !== null && typeof options === 'object' && options.shell
        ? [...commandLineWords(file), ...argumentList]
        : [file, ...argumentList]
    }
  }
  const executable = executableName(words[0] ?? '')
  return { executable, subcommand: subcommandOf(executable, words.slice(1)) }
}

// Arguments the wrapped call would reject must reach it and fail there, as they would
// without the profile, rather than fail here first.
function describeOrUnknown(name: string, args: readonly unknown[]): Pick<SpawnRecord, 'executable' | 'subcommand'> {
  try {
    return describeInvocation(name, args)
  } catch {
    return { executable: 'unknown', subcommand: null }
  }
}

interface ExitObservable {
  once(event: string, listener: () => void): unknown
}

function isExitObservable(value: unknown): value is ExitObservable {
  return value !== null && typeof value === 'object' && typeof (value as ExitObservable).once === 'function'
}

// Wraps the child_process functions of `target` in place and returns their recorder. A
// wrapper returns, throws and inherits exactly what the wrapped call does: it adds only
// an `exit` and a `close` listener to a child it is handed. A call one wrapper makes into
// another, as `exec` does into `execFile`, is counted once.
export function profileChildProcesses(target: Record<string | symbol, unknown>): SpawnRecorder {
  const installed = target[RECORDER] as SpawnRecorder | undefined
  if (installed !== undefined) return installed

  let generation = 0
  let depth = 0
  let completed: SpawnRecord[] = []
  const running = new Set<{ invocation: Pick<SpawnRecord, 'executable' | 'subcommand'>, startedAt: number }>()

  function track(child: unknown, invocation: Pick<SpawnRecord, 'executable' | 'subcommand'>, startedAt: number): void {
    if (!isExitObservable(child)) return
    const entry = { invocation, startedAt }
    const recordedGeneration = generation
    running.add(entry)
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      running.delete(entry)
      // A child of an earlier test file that outlived it belongs to no file's record.
      if (recordedGeneration !== generation) return
      completed.push({ ...invocation, durationMs: performance.now() - startedAt, exited: true })
    }
    child.once('exit', finish)
    // A child that never started emits `error` and `close` but no `exit`.
    child.once('close', finish)
  }

  function wrap(name: string, original: (...args: unknown[]) => unknown, mode: Mode): (...args: unknown[]) => unknown {
    return function profiled(this: unknown, ...args: unknown[]): unknown {
      if (depth > 0) return Reflect.apply(original, this, args)
      const invocation = describeOrUnknown(name, args)
      const startedAt = performance.now()
      depth += 1
      let result: unknown
      try {
        result = Reflect.apply(original, this, args)
      } finally {
        depth -= 1
        if (mode === 'sync') completed.push({ ...invocation, durationMs: performance.now() - startedAt, exited: true })
      }
      if (mode === 'child') track(result, invocation, startedAt)
      if (mode === 'promise') track((result as { child?: unknown } | undefined)?.child, invocation, startedAt)
      return result
    }
  }

  for (const [name, mode] of Object.entries(PROFILED_FUNCTIONS)) {
    const original = target[name]
    if (typeof original !== 'function') continue
    const wrapper = wrap(name, original as (...args: unknown[]) => unknown, mode)
    const descriptors: Record<string | symbol, PropertyDescriptor> = Object.getOwnPropertyDescriptors(original)
    const customDescriptor = descriptors[promisify.custom]
    delete descriptors.prototype
    delete descriptors[promisify.custom]
    Object.defineProperties(wrapper, descriptors)
    // util.promisify(execFile) resolves through this symbol to a function that calls the
    // unwrapped original, so it is wrapped too; the promise it returns carries the child.
    if (typeof customDescriptor?.value === 'function') {
      Object.defineProperty(wrapper, promisify.custom, {
        ...customDescriptor,
        value: wrap(name, customDescriptor.value as (...args: unknown[]) => unknown, 'promise'),
      })
    }
    target[name] = wrapper
  }

  const recorder: SpawnRecorder = {
    records: () => [
      ...completed,
      ...[...running].map(({ invocation, startedAt }) => ({
        ...invocation,
        durationMs: performance.now() - startedAt,
        exited: false,
      })),
    ],
    reset: () => {
      generation += 1
      completed = []
      running.clear()
    },
  }
  Object.defineProperty(target, RECORDER, { value: recorder })
  return recorder
}

function countTests(suite: Readonly<RunnerTestSuite | RunnerTestFile>): number {
  let count = 0
  for (const task of suite.tasks) {
    if (task.type === 'test') count += 1
    else if (task.type === 'suite') count += countTests(task)
  }
  return count
}

export function spawnProfileFileName(file: string): string {
  return `${file.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

// Run from a setup file, once per test file. With the variable set it wraps the
// worker's child_process module, starts a fresh record for this file, and writes that
// record when the file's last hook has run.
export function recordSpawnProfile(environment: NodeJS.ProcessEnv): void {
  const directory = environment[SPAWN_PROFILE_VARIABLE]
  if (directory === undefined || directory === '') return
  const childProcess = createRequire(import.meta.url)('node:child_process') as Record<string | symbol, unknown>
  const recorder = profileChildProcesses(childProcess)
  // ES module imports of node:child_process read the wrapped functions from here on.
  syncBuiltinESMExports()
  recorder.reset()
  const startedAt = performance.now()
  afterAll(({}, suite) => {
    const profile: SpawnProfileFile = {
      file: suite.file.name,
      project: suite.file.projectName ?? '',
      tests: countTests(suite),
      durationMs: performance.now() - startedAt,
      spawns: recorder.records(),
    }
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, spawnProfileFileName(profile.file)), `${JSON.stringify(profile)}\n`)
  })
}
