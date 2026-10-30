import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function queuedTickets(path: string): string[] {
  return existsSync(path) ? readdirSync(path).filter((name) => name.endsWith('.json')) : []
}

// Waits for exactly `count` tickets. The lock owner publishes owner.json before it
// withdraws its own ticket, so "at least" would count the owner as a waiter.
async function waitForTicketCount(path: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (queuedTickets(path).length !== count) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} tickets in ${path}; found ${JSON.stringify(queuedTickets(path))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface RunResult {
  status: number | null
  stderr: string
  stdout: string
}

function describeResults(results: readonly RunResult[]): string {
  return results.map(({ status, stderr, stdout }, index) => [
    `child ${index + 1} exited with status ${String(status)}`,
    `--- stdout ---\n${stdout}`,
    `--- stderr ---\n${stderr}`,
  ].join('\n')).join('\n')
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'] as const,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stderr, stdout }))
  })
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('test suite wrapper', () => {
  it('serializes linked-worktree invocations and forwards each gate flag once', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-run-tests-'))
    fixtures.push(fixture)
    const repository = join(fixture, 'repository')
    const scripts = join(repository, 'scripts')
    const vitest = join(repository, 'node_modules', 'vitest')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(vitest, { recursive: true })
    writeFileSync(
      join(scripts, 'run-tests.mjs'),
      readFileSync(join(import.meta.dirname, '..', 'scripts', 'run-tests.mjs')),
    )
    writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}\n')
    writeFileSync(join(vitest, 'vitest.mjs'), [
      "import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "const root = process.env.ORCHESTRATION_TEST_SHARED_ROOT",
      "if (root === undefined) throw new Error('missing shared test root')",
      "const active = join(root, 'active')",
      "try { mkdirSync(active) } catch { appendFileSync(join(root, 'overlap'), 'overlap\\n') }",
      "appendFileSync(join(root, 'args'), `${JSON.stringify(process.argv.slice(2))}\\n`)",
      "if (process.argv.includes('--pool=threads')) {",
      "  const release = join(root, 'release-first')",
      '  while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20))',
      '} else {',
      '  await new Promise((resolve) => setTimeout(resolve, 400))',
      '}',
      'rmSync(active, { recursive: true, force: true })',
      '',
    ].join('\n'))

    execFileSync('git', ['init', '-q'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['add', '--force', '.'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'test fixture'], { cwd: repository, stdio: 'ignore' })
    const firstWorktree = join(fixture, 'first')
    const secondWorktree = join(fixture, 'second')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'first', firstWorktree], {
      cwd: repository,
      stdio: 'ignore',
    })
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'second', secondWorktree], {
      cwd: repository,
      stdio: 'ignore',
    })
    const sharedRoot = join(fixture, 'shared')
    mkdirSync(sharedRoot)
    const env = {
      ...process.env,
      ORCHESTRATION_TEST_SHARED_ROOT: sharedRoot,
    }

    const queue = join(repository, '.git', '.orchestration-test-suite-lock-queue')
    const children: Promise<RunResult>[] = []
    let contentionError: unknown
    try {
      children.push(run(
        process.execPath,
        [join(firstWorktree, 'scripts', 'run-tests.mjs'), '--pool=threads'],
        firstWorktree,
        env,
      ))
      await waitForPath(join(repository, '.git', '.orchestration-test-suite-lock', 'owner.json'))
      // The owner withdraws its ticket only after publishing owner.json. Until it has,
      // a single ticket may be the owner's, and the third invocation could then race the
      // second for its place in the queue.
      await waitForTicketCount(queue, 0)
      children.push(run(
        process.execPath,
        [join(secondWorktree, 'scripts', 'run-tests.mjs'), '--no-file-parallelism'],
        secondWorktree,
        env,
      ))
      await waitForTicketCount(queue, 1)
      children.push(run(
        process.execPath,
        [join(firstWorktree, 'scripts', 'run-tests.mjs'), '--pool=forks'],
        firstWorktree,
        env,
      ))
      await waitForTicketCount(queue, 2)
    } catch (error) {
      contentionError = error
    } finally {
      writeFileSync(join(sharedRoot, 'release-first'), '')
    }
    const results = await Promise.all(children)
    const report = describeResults(results)
    if (contentionError !== undefined) {
      throw new Error(`${contentionError instanceof Error ? contentionError.message : String(contentionError)}\n${report}`)
    }

    expect(results.map(({ status }) => status), report).toEqual([0, 0, 0])
    expect(results.map(({ stderr }) => stderr), report).toEqual(['', '', ''])
    expect(existsSync(join(sharedRoot, 'overlap')), report).toBe(false)
    const invocations = readFileSync(join(sharedRoot, 'args'), 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[])
    expect(invocations, report).toEqual([
      ['run', '--pool=threads'],
      ['run', '--no-file-parallelism'],
      ['run', '--pool=forks'],
    ])
    expect(results.some(({ stdout }) => stdout.includes('waiting for its repository lock')), report).toBe(true)
  })

  it('rejects a live PID when its process identity does not match', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-run-tests-owner-'))
    fixtures.push(fixture)
    const scripts = join(fixture, 'scripts')
    const vitest = join(fixture, 'node_modules', 'vitest')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(vitest, { recursive: true })
    writeFileSync(join(scripts, 'run-tests.mjs'), readFileSync(join(import.meta.dirname, '..', 'scripts', 'run-tests.mjs')))
    writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}\n')
    writeFileSync(join(vitest, 'vitest.mjs'), '')
    const lock = join(fixture, '.orchestration-test-suite-lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      token: 'previous-owner',
      processIdentity: 'not-the-current-process',
      acquiredAt: new Date().toISOString(),
      cwd: fixture,
    })}\n`)

    const result = await run(process.execPath, [join(scripts, 'run-tests.mjs')], fixture, process.env)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('waits for a live owner when its process identity is temporarily unavailable', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-run-tests-owner-unknown-'))
    fixtures.push(fixture)
    const scripts = join(fixture, 'scripts')
    const vitest = join(fixture, 'node_modules', 'vitest')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(vitest, { recursive: true })
    const wrapper = readFileSync(join(import.meta.dirname, '..', 'scripts', 'run-tests.mjs'), 'utf8')
      .replace(
        'function processIdentity(pid) {',
        "function processIdentity(pid) {\n  if (String(pid) === process.env.ORCHESTRATION_TEST_UNKNOWN_IDENTITY_PID) return null",
      )
    writeFileSync(join(scripts, 'run-tests.mjs'), wrapper)
    writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}\n')
    writeFileSync(join(vitest, 'vitest.mjs'), '')
    const lock = join(fixture, '.orchestration-test-suite-lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      token: 'previous-owner',
      processIdentity: 'temporarily-unverifiable',
      acquiredAt: new Date().toISOString(),
      cwd: fixture,
    })}\n`)

    const result = await run(process.execPath, [join(scripts, 'run-tests.mjs')], fixture, {
      ...process.env,
      ORCHESTRATION_TEST_LOCK_TIMEOUT_MS: '100',
      ORCHESTRATION_TEST_UNKNOWN_IDENTITY_PID: String(process.pid),
    })

    expect(result.status).toBe(75)
    expect(result.stdout).toContain('identity unavailable')
    expect(result.stderr).toMatch(/Timed out after 100ms/)
    expect(existsSync(lock)).toBe(true)
  })

  it('backs off and times out when an abandoned lock cannot be reclaimed', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-run-tests-reclaim-timeout-'))
    fixtures.push(fixture)
    const scripts = join(fixture, 'scripts')
    const vitest = join(fixture, 'node_modules', 'vitest')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(vitest, { recursive: true })
    const wrapper = readFileSync(join(import.meta.dirname, '..', 'scripts', 'run-tests.mjs'), 'utf8')
      .replace(
        'renameSync(lockDirectory, abandoned)',
        "if (process.env.ORCHESTRATION_TEST_RECLAIM_EPERM === '1') {\n      writeFileSync(process.env.ORCHESTRATION_TEST_RECLAIM_ATTEMPTS, 'attempt\\n', { flag: 'a' })\n      const error = new Error('reclaim denied')\n      error.code = 'EPERM'\n      throw error\n    }\n    renameSync(lockDirectory, abandoned)",
      )
    writeFileSync(join(scripts, 'run-tests.mjs'), wrapper)
    writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}\n')
    writeFileSync(join(vitest, 'vitest.mjs'), '')
    const lock = join(fixture, '.orchestration-test-suite-lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      token: 'previous-owner',
      processIdentity: 'not-the-current-process',
      acquiredAt: new Date().toISOString(),
      cwd: fixture,
    })}\n`)
    const reclaimAttempts = join(fixture, 'reclaim-attempts')

    const startedAt = performance.now()
    const result = await run(process.execPath, [join(scripts, 'run-tests.mjs')], fixture, {
      ...process.env,
      ORCHESTRATION_TEST_LOCK_TIMEOUT_MS: '400',
      ORCHESTRATION_TEST_RECLAIM_ATTEMPTS: reclaimAttempts,
      ORCHESTRATION_TEST_RECLAIM_EPERM: '1',
    })

    expect(result.status).toBe(75)
    expect(result.stderr).toMatch(/Timed out after 400ms/)
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(300)
    // The 250ms backoff admits two scheduled attempts within the 400ms budget; the
    // bound leaves room for the short final sleeps near the deadline on slow runners.
    const attemptCount = readFileSync(reclaimAttempts, 'utf8').trim().split(/\r?\n/).length
    expect(attemptCount).toBeGreaterThanOrEqual(1)
    expect(attemptCount).toBeLessThanOrEqual(4)
    expect(existsSync(lock)).toBe(true)
  })

  it('stops waiting at the configured deadline and reports the owner', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-run-tests-timeout-'))
    fixtures.push(fixture)
    const scripts = join(fixture, 'scripts')
    const vitest = join(fixture, 'node_modules', 'vitest')
    const sharedRoot = join(fixture, 'shared')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(vitest, { recursive: true })
    mkdirSync(sharedRoot)
    writeFileSync(join(scripts, 'run-tests.mjs'), readFileSync(join(import.meta.dirname, '..', 'scripts', 'run-tests.mjs')))
    writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}\n')
    writeFileSync(join(vitest, 'vitest.mjs'), [
      "import { existsSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "const release = join(process.env.ORCHESTRATION_TEST_SHARED_ROOT, 'release')",
      'while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20))',
      '',
    ].join('\n'))
    const owner = run(process.execPath, [join(scripts, 'run-tests.mjs')], fixture, {
      ...process.env,
      ORCHESTRATION_TEST_SHARED_ROOT: sharedRoot,
    })
    await waitForPath(join(fixture, '.orchestration-test-suite-lock', 'owner.json'))

    let waiter
    try {
      waiter = await run(process.execPath, [join(scripts, 'run-tests.mjs')], fixture, {
        ...process.env,
        ORCHESTRATION_TEST_LOCK_TIMEOUT_MS: '100',
      })
    } finally {
      writeFileSync(join(sharedRoot, 'release'), '')
    }
    const ownerResult = await owner

    expect(ownerResult.status).toBe(0)
    expect(waiter.status).toBe(75)
    expect(waiter.stdout).toMatch(/waiting for its repository lock \(PID \d+, acquired .+, cwd .+\)/)
    expect(waiter.stderr).toMatch(/Timed out after 100ms.+Lock owner: PID \d+, acquired .+, cwd .+/s)
  })

  it('lets the configured wait limit exceed the 15-minute default', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-run-tests-raised-limit-'))
    fixtures.push(fixture)
    const scripts = join(fixture, 'scripts')
    const vitest = join(fixture, 'node_modules', 'vitest')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(vitest, { recursive: true })
    // Starting the wait clock 15 minutes in the past proves the waiter keeps waiting past
    // the default instead of sitting out a real quarter hour.
    const wrapper = readFileSync(join(import.meta.dirname, '..', 'scripts', 'run-tests.mjs'), 'utf8')
      .replace(
        'const waitStartedAt = performance.now()',
        'const waitStartedAt = performance.now() - 15 * 60_000',
      )
    writeFileSync(join(scripts, 'run-tests.mjs'), wrapper)
    writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}\n')
    writeFileSync(join(vitest, 'vitest.mjs'), '')
    // A fresh lock whose owner record is not yet published counts as held.
    const lock = join(fixture, '.orchestration-test-suite-lock')
    mkdirSync(lock)
    const raisedLimit = 15 * 60_000 + 300

    const startedAt = performance.now()
    const result = await run(process.execPath, [join(scripts, 'run-tests.mjs')], fixture, {
      ...process.env,
      ORCHESTRATION_TEST_LOCK_TIMEOUT_MS: String(raisedLimit),
    })

    expect(result.status).toBe(75)
    expect(result.stderr).toContain(`Timed out after ${raisedLimit}ms waiting for the repository test lock.`)
    expect(result.stderr).toContain('Lock owner: owner record not yet available.')
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(200)
    expect(existsSync(lock)).toBe(true)
  })
})
