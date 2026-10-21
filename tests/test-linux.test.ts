import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('Linux verification wrapper', () => {
  it('reports docker exiting before it reads the archive instead of crashing on the pipe', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-test-linux-'))
    fixtures.push(fixture)
    const repository = join(fixture, 'repository')
    const scripts = join(repository, 'scripts')
    mkdirSync(scripts, { recursive: true })
    // Windows resolves a bare `docker` only to an executable, so the fake runs under
    // Node instead of being found on PATH.
    const fakeDocker = join(fixture, 'fake-docker.mjs')
    writeFileSync(fakeDocker, [
      "process.stderr.write('docker: error during connect: the engine is not running.\\n')",
      'process.exit(1)',
      '',
    ].join('\n'))
    const wrapper = readFileSync(join(import.meta.dirname, '..', 'scripts', 'test-linux.mjs'), 'utf8')
      .replace("spawn('docker', [", 'spawn(process.execPath, [process.env.ORCHESTRATION_TEST_FAKE_DOCKER,')
    writeFileSync(join(scripts, 'test-linux.mjs'), wrapper)
    // Far more than a pipe buffer holds, so git is still writing after docker has gone.
    writeFileSync(join(repository, 'payload.txt'), 'x'.repeat(8 * 1024 * 1024))

    execFileSync('git', ['init', '-q'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['add', '--force', '.'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'test fixture'], { cwd: repository, stdio: 'ignore' })

    const result = await run(process.execPath, [join(scripts, 'test-linux.mjs')], repository, {
      ...process.env,
      ORCHESTRATION_TEST_FAKE_DOCKER: fakeDocker,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Linux verification failed with exit code 1.')
    expect(result.stderr).not.toContain('git archive failed')
    expect(result.stderr).not.toContain('EPIPE')
  })
})
