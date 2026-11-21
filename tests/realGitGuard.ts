import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { callerFrames, describeOrUnknown } from './spawnProfile.ts'

// A loop test on the in-memory checkout must not reach real git: its repository root is
// a plain temporary directory, so a git child started there fails with status 128 and
// takes an error path real git would not take, and one started under a checkout would act
// on that checkout. The fake cannot refuse a child it never sees, so this guard watches
// the worker's child processes instead. A fake repository marks its root; every git child
// whose directory lies under a marked root is recorded with its caller, and the fake's
// end-of-test check fails the test with that list. The child still runs as it would
// without the guard, so the code under test takes the same path it would take.

const GUARDED_FUNCTIONS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']
// Shared by every module instance in a worker, as the worker keeps one child_process module.
const ROOTS = Symbol.for('orchestration.realGitGuard.roots')
const INSTALLED = Symbol.for('orchestration.realGitGuard.installed')
// Deep enough to pass a test runner's frames and reach the code that started the child.
const CALLER_STACK_DEPTH = 64

type Roots = Map<string, string[]>

function roots(): Roots {
  const holder = globalThis as Record<symbol, unknown>
  holder[ROOTS] ??= new Map<string, string[]>()
  return holder[ROOTS] as Roots
}

function comparable(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isUnder(root: string, path: string): boolean {
  const inside = relative(root, comparable(path))
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}

// The directory git acts in: the child's own, or the one its -C options name.
function gitDirectory(argv: readonly string[], cwd: string): string {
  let directory = cwd
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '-C' && index + 1 < argv.length) {
      directory = resolve(directory, argv[index + 1]!)
      index += 1
    } else if (argument === '-c') {
      index += 1
    } else if (!argument.startsWith('-')) {
      break
    }
  }
  return directory
}

function inspect(name: string, args: readonly unknown[], guarded: (...args: unknown[]) => unknown): void {
  const marked = roots()
  if (marked.size === 0) return
  const { executable, argv = [], cwd } = describeOrUnknown(name, args)
  if (executable !== 'git' || cwd === null || cwd === undefined) return
  const directory = gitDirectory(argv, cwd)
  for (const [root, caught] of marked) {
    if (!isUnder(root, directory)) continue
    const limit = Error.stackTraceLimit
    const holder: { stack?: string } = {}
    try {
      Error.stackTraceLimit = CALLER_STACK_DEPTH
      Error.captureStackTrace(holder, guarded)
    } finally {
      Error.stackTraceLimit = limit
    }
    const { caller, via } = callerFrames(holder.stack ?? '')
    const from = via === null ? caller ?? 'an unknown caller' : `${caller ?? 'an unknown caller'} (via ${via})`
    caught.push(`git ${argv.join(' ')} in ${directory}, started by ${from}`)
  }
}

function guard(name: string, original: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  return function guarded(this: unknown, ...args: unknown[]): unknown {
    inspect(name, args, guarded)
    return Reflect.apply(original, this, args)
  }
}

/**
 * Wraps the child_process functions of `target` in place, once per worker. A wrapper
 * returns, throws and inherits exactly what the wrapped call does; with no root marked
 * it only checks that none is.
 */
export function installRealGitGuard(target: Record<string | symbol, unknown>): void {
  const holder = globalThis as Record<symbol, unknown>
  if (holder[INSTALLED] === target) return
  for (const name of GUARDED_FUNCTIONS) {
    const original = target[name]
    if (typeof original !== 'function') continue
    const wrapper = guard(name, original as (...args: unknown[]) => unknown)
    const descriptors: Record<string | symbol, PropertyDescriptor> = Object.getOwnPropertyDescriptors(original)
    const customDescriptor = descriptors[promisify.custom]
    delete descriptors.prototype
    delete descriptors[promisify.custom]
    Object.defineProperties(wrapper, descriptors)
    // util.promisify(execFile) resolves through this symbol to a function that calls the
    // unwrapped original, so it is guarded too.
    if (typeof customDescriptor?.value === 'function') {
      Object.defineProperty(wrapper, promisify.custom, {
        ...customDescriptor,
        value: guard(name, customDescriptor.value as (...args: unknown[]) => unknown),
      })
    }
    target[name] = wrapper
  }
  holder[INSTALLED] = target
}

/** Marks `root`, and returns the list the git children started under it are added to. */
export function markFakeRoot(root: string): string[] {
  const caught: string[] = []
  roots().set(comparable(root), caught)
  return caught
}

/** Stops watching `root`; a later fake repository at the same path marks it afresh. */
export function unmarkFakeRoot(root: string): void {
  roots().delete(comparable(root))
}
