// The setup every CLI suite shares: the CLI under test, the environment its children see,
// and a private temporary repository created before each test and removed after it.
// Importing this module registers those hooks in the importing file.
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect } from 'vitest'
import { PROCESS_TEST_TIMEOUT_MS, TestProcessRegistry } from './testProcess.ts'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const CLI = join(HERE, '..', 'src', 'cli.ts')

// Several of these run `cli.ts loop` and rely on the loop deciding to exit — a
// burst-failure cap, an exhausted cycle cap, a rejected PID lock. When a condition stops
// holding, a synchronous spawn becomes a permanent block: `spawnSync` cannot be
// interrupted by vitest's test timeout, so the worker freezes with no failure and no
// output. That happened inside a merge gate twice, and each attempt sat for fifty minutes
// before anyone thought to look at the process list. A bound turns it into a failed test.
export const CLI_TIMEOUT_MS = 120_000

// The loop reads its settings from the environment, so inheriting the caller's is enough
// to change what the CLI under test does. An operator running the suite in a checkout
// where a loop is started with `CORE_AUTO_UPDATE=false` made a test asserting
// `auto-update on` fail, which then blocked every merge in that repository until the
// variable was noticed. Only the settings a test sets deliberately may reach the child.
export const INHERITED_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !isLoopSetting(name)),
)

// The ORCHESTRATION_ prefix belongs here for the same reason and cost the same way: the
// hidden-console launcher marks its tree with ORCHESTRATION_WINDOWS_PROCESS_ROOT_PID, a
// daemon running the merge gate passes it down, and a CLI started by these tests then
// took the daemon for its own process-tree root and refused the PID lock it should have
// won. Every merge failed until the variable was noticed. INIT_CWD belongs here too: npm
// sets it to the checkout running the suite, the CLI searches for a fleet from it, and a
// fleet's own project checkouts sit inside that fleet.
export function isLoopSetting(name: string): boolean {
  return name === 'PROJECT' || name === 'PROJECT_ADAPTER' || name === 'FORGE' || name === 'INIT_CWD'
    || name === 'RUNNER' || name === 'UPSTREAM_REMOTE' || name === 'UPSTREAM_BRANCH'
    || /^(CORE_|MAX_|SCAN_|TASK_|REVIEW_|ISSUE_|CI_|AUTO_|POLL_|ORCHESTRATION_)/.test(name)
}

export const CORE_ENV = {
  ...INHERITED_ENV,
  PROJECT: 'shiora',
  PROJECT_ADAPTER: join(HERE, 'fixtures', 'project-loader-fixture.ts'),
}

export let repoRoot: string
export let extraRoots: string[]
export const testProcesses = new TestProcessRegistry()

beforeEach(() => {
  // The runner's temp path contains an 8.3 short name when the account name is long
  // (RUNNER~1 for runneradmin), while paths the CLI reports are canonical. Compare like
  // with like, or the assertions differ only in a place no developer machine reproduces.
  repoRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'orch-cli-')))
  extraRoots = []
  const init = spawnSync('git', ['init'], { cwd: repoRoot, windowsHide: true })
  expect(init.status).toBe(0)
})

// On Windows a CLI child that has just exited can still hold a handle inside the
// temporary repository for a moment, and the first removal then fails with EPERM.
// Retrying with a short backoff is how Node expects that race to be handled.
const removalOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const

afterEach(async () => {
  await testProcesses.cleanup()
  rmSync(repoRoot, removalOptions)
  for (const root of extraRoots) rmSync(root, removalOptions)
})

export function daemonFile(name: string): string {
  return join(repoRoot, 'orchestration', 'queue', name)
}

export function git(args: string[], cwd = repoRoot): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

export function childCompletion(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', reject)
    // `exit` can precede the final stdout/stderr data events. `close` proves that the
    // process and its stdio handles have all finished before assertions inspect output.
    child.on('close', (code) => resolve({ code, output }))
  })
}

export async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TEST_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
