import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import { PROCESS_TEST_TIMEOUT_MS, TestProcessRegistry } from './testProcess.ts'

const fixtures: string[] = []
const testProcesses = new TestProcessRegistry()

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{
  status: number | null
  stderr: string
  stdout: string
}> {
  return new Promise((resolve, reject) => {
    const child = testProcesses.spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    // A wrapper that never finishes must fail with what it printed, well inside the
    // test timeout, rather than as a bare timeout that leaves its tree in the fixture.
    const deadline = setTimeout(() => {
      reject(new Error(`The Linux verification wrapper did not finish.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, PROCESS_TEST_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.once('close', (status) => {
      clearTimeout(deadline)
      resolve({ status, stderr, stdout })
    })
  })
}

async function removeFixture(root: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (existsSync(root)) {
    try {
      operatingSystem.removeDirectory(root)
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

afterEach(async () => {
  await testProcesses.cleanup()
  for (const fixture of fixtures.splice(0)) await removeFixture(fixture)
})

// Node delivers docker's exit and the failed write to its stdin in whichever order the
// operating system reports them. A docker that exits outright usually loses the race to
// the broken pipe; one whose stdin outlives it, held by a helper it started, makes the
// exit arrive first every time, because no write to the still-open pipe can fail.
const fakeDockers = [
  {
    order: 'the broken pipe arrives first',
    source: [
      "process.stderr.write('docker: error during connect: the engine is not running.\\n')",
      'process.exit(1)',
      '',
    ],
  },
  {
    order: 'its exit arrives first',
    source: [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      'const helper = spawn(process.execPath, [',
      `  '-e', 'setTimeout(() => {}, ${PROCESS_TEST_TIMEOUT_MS})',`,
      "], { detached: true, stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true })",
      'writeFileSync(process.env.ORCHESTRATION_TEST_FAKE_DOCKER_HELPER, `${helper.pid}`)',
      'helper.unref()',
      "process.stderr.write('docker: error during connect: the engine is not running.\\n')",
      'process.exit(1)',
      '',
    ],
  },
]

describe('Linux verification wrapper', () => {
  it.each(fakeDockers)(
    'reports docker exiting before it reads the archive when $order',
    async ({ source }) => {
      const fixture = mkdtempSync(join(tmpdir(), 'orch-test-linux-'))
      fixtures.push(fixture)
      const repository = join(fixture, 'repository')
      const scripts = join(repository, 'scripts')
      mkdirSync(scripts, { recursive: true })
      // Windows resolves a bare `docker` only to an executable, so the fake runs under
      // Node instead of being found on PATH.
      const fakeDocker = join(fixture, 'fake-docker.mjs')
      const helperPidFile = join(fixture, 'fake-docker-helper.pid')
      writeFileSync(fakeDocker, source.join('\n'))
      testProcesses.trackPid(() => existsSync(helperPidFile)
        ? Number(readFileSync(helperPidFile, 'utf8'))
        : undefined)
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
        ORCHESTRATION_TEST_FAKE_DOCKER_HELPER: helperPidFile,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Linux verification failed with exit code 1.')
      expect(result.stderr).not.toContain('git archive failed')
      expect(result.stderr).not.toContain('EPIPE')
    },
  )
})
