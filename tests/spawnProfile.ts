import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { isAbsolute, join, relative, win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeEach, type RunnerTestFile, type RunnerTestSuite } from 'vitest'

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
  // Everything after the executable, and the directory the child started in, so a
  // question asked twice in a row can be recognised.
  argv?: string[]
  cwd?: string | null
  // Who asked for the child, as a repository-relative `file:line`: the first stack frame
  // outside Node internals, node_modules and this profile, then the next frame outside
  // that frame's file, so a `git()` wrapper is attributed to whoever called it. A frame
  // outside the repository keeps its absolute path.
  caller?: string | null
  via?: string | null
  // The full name of the test running when the child started; null in a file-level hook.
  test?: string | null
  // The order in which the children of one file started.
  sequence?: number
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
  // Names the test the next children belong to, or null between tests.
  startTest(name: string | null): void
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
// Deep enough to pass a test runner's frames and reach the code that asked for a child.
const CALLER_STACK_DEPTH = 64
const REPOSITORY = join(import.meta.dirname, '..')

type Invocation = Omit<SpawnRecord, 'durationMs' | 'exited'>

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

interface CallOptions {
  execPath?: unknown
  shell?: unknown
  cwd?: unknown
}

function callOptions(name: string, args: readonly unknown[]): CallOptions | undefined {
  const options = name === 'exec' || name === 'execSync' || !Array.isArray(args[1]) ? args[1] : args[2]
  return options !== null && typeof options === 'object' ? options as CallOptions : undefined
}

// The executable and the arguments a call to one of the profiled functions starts.
function invocationWords(name: string, args: readonly unknown[]): string[] {
  if (name === 'exec' || name === 'execSync') return commandLineWords(String(args[0]))
  const argumentList = Array.isArray(args[1]) ? args[1].map(String) : []
  const options = callOptions(name, args)
  if (name === 'fork') {
    const execPath = typeof options?.execPath === 'string' ? options.execPath : process.execPath
    return [execPath, String(args[0]), ...argumentList]
  }
  const file = String(args[0])
  return options?.shell ? [...commandLineWords(file), ...argumentList] : [file, ...argumentList]
}

// Which executable and subcommand a call to one of the profiled functions starts.
export function describeInvocation(name: string, args: readonly unknown[]): Pick<SpawnRecord, 'executable' | 'subcommand'> {
  const words = invocationWords(name, args)
  const executable = executableName(words[0] ?? '')
  return { executable, subcommand: subcommandOf(executable, words.slice(1)) }
}

// Arguments the wrapped call would reject must reach it and fail there, as they would
// without the profile, rather than fail here first.
function describeOrUnknown(name: string, args: readonly unknown[]): Pick<SpawnRecord, 'executable' | 'subcommand' | 'argv' | 'cwd'> {
  try {
    const words = invocationWords(name, args)
    const executable = executableName(words[0] ?? '')
    const cwd = callOptions(name, args)?.cwd
    return {
      executable,
      subcommand: subcommandOf(executable, words.slice(1)),
      argv: words.slice(1),
      cwd: cwd === undefined || cwd === null ? process.cwd() : String(cwd),
    }
  } catch {
    return { executable: 'unknown', subcommand: null, argv: [], cwd: null }
  }
}

// A stack frame's file, relative to the repository when it lies inside it, or null for a
// frame that names no file on disk, such as `node:internal/...` or `<anonymous>`.
function frameFile(location: string): string | null {
  const file = location.startsWith('file://') ? fileURLToPath(location) : location
  if (!isAbsolute(file)) return null
  const inRepository = relative(REPOSITORY, file)
  const shown = inRepository === '' || inRepository.startsWith('..') || isAbsolute(inRepository) ? file : inRepository
  return shown.replace(/\\/g, '/')
}

const PROFILE_FILE = frameFile(fileURLToPath(import.meta.url))

// The caller, and the frame that called into the caller's file, out of a V8 stack.
export function callerFrames(stack: string): Pick<SpawnRecord, 'caller' | 'via'> {
  const frames: { file: string, line: string }[] = []
  for (const text of stack.split('\n')) {
    const match = /^\s*at (?:.*?\()?(.+?):(\d+):\d+\)?$/.exec(text)
    if (match === null) continue
    const file = frameFile(match[1]!)
    if (file === null || file === PROFILE_FILE || /(^|\/)node_modules\//.test(file)) continue
    frames.push({ file, line: match[2]! })
  }
  const caller = frames[0]
  if (caller === undefined) return { caller: null, via: null }
  const via = frames.find((frame) => frame.file !== caller.file)
  return { caller: `${caller.file}:${caller.line}`, via: via === undefined ? null : `${via.file}:${via.line}` }
}

// Reads the stack above `wrapper` without disturbing the call: a failure here only
// leaves the record without a caller.
function callerOf(wrapper: (...args: unknown[]) => unknown): Pick<SpawnRecord, 'caller' | 'via'> {
  const limit = Error.stackTraceLimit
  try {
    Error.stackTraceLimit = CALLER_STACK_DEPTH
    const holder: { stack?: string } = {}
    Error.captureStackTrace(holder, wrapper)
    return callerFrames(holder.stack ?? '')
  } catch {
    return { caller: null, via: null }
  } finally {
    Error.stackTraceLimit = limit
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
  let sequence = 0
  let test: string | null = null
  let completed: SpawnRecord[] = []
  const running = new Set<{ invocation: Invocation, startedAt: number }>()

  function track(child: unknown, invocation: Invocation, startedAt: number): void {
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
      const invocation: Invocation = { ...describeOrUnknown(name, args), ...callerOf(profiled), test, sequence }
      sequence += 1
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
      sequence = 0
      test = null
      completed = []
      running.clear()
    },
    startTest: (name) => {
      test = name
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
  beforeEach(({ task }) => recorder.startTest(task.fullTestName ?? task.name))
  afterEach(() => recorder.startTest(null))
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
