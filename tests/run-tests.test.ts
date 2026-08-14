import { execFileSync, spawn } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{
  status: number | null
  stderr: string
  stdout: string
}> {
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
      "import { appendFileSync, mkdirSync, rmSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "const root = process.env.ORCHESTRATION_TEST_SHARED_ROOT",
      "if (root === undefined) throw new Error('missing shared test root')",
      "const active = join(root, 'active')",
      "try { mkdirSync(active) } catch { appendFileSync(join(root, 'overlap'), 'overlap\\n') }",
      "appendFileSync(join(root, 'args'), `${JSON.stringify(process.argv.slice(2))}\\n`)",
      'await new Promise((resolve) => setTimeout(resolve, 400))',
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
    const env = { ...process.env, ORCHESTRATION_TEST_SHARED_ROOT: sharedRoot }

    const first = run(
      process.execPath,
      [join(firstWorktree, 'scripts', 'run-tests.mjs'), '--pool=threads'],
      firstWorktree,
      env,
    )
    const second = run(
      process.execPath,
      [join(secondWorktree, 'scripts', 'run-tests.mjs'), '--poolOptions.threads.singleThread'],
      secondWorktree,
      env,
    )
    const results = await Promise.all([first, second])

    expect(results.map(({ status }) => status)).toEqual([0, 0])
    expect(results.map(({ stderr }) => stderr)).toEqual(['', ''])
    expect(() => readFileSync(join(sharedRoot, 'overlap'), 'utf8')).toThrow()
    const invocations = readFileSync(join(sharedRoot, 'args'), 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[])
    expect(invocations).toHaveLength(2)
    expect(invocations).toContainEqual(['run', '--pool=threads'])
    expect(invocations).toContainEqual(['run', '--poolOptions.threads.singleThread'])
    expect(results.some(({ stdout }) => stdout.includes('waiting for its repository lock'))).toBe(true)
  })
})
