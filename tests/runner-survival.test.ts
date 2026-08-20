import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import {
  LOOP_RESTART_PREDECESSOR_PID_ENV, LOOP_RESTART_READY_FILE_ENV,
} from '../src/restart.ts'
import { TestProcessRegistry } from './testProcess.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.ts')
const PROJECT_ADAPTER = join(HERE, 'fixtures', 'project-loader-fixture.ts')
const fixtureRoots: string[] = []
const testProcesses = new TestProcessRegistry()

interface SpawnProbe {
  command: string
  args: string[]
  cwd: string | undefined
  detached: boolean
  hasWindowsHide: boolean
  windowsHide: boolean | undefined
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function environmentWithoutRestartHandover(): NodeJS.ProcessEnv {
  const {
    [LOOP_RESTART_PREDECESSOR_PID_ENV]: predecessorPid,
    [LOOP_RESTART_READY_FILE_ENV]: readyFile,
    ...rest
  } = process.env
  void predecessorPid
  void readyFile
  return rest
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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
  for (const root of fixtureRoots.splice(0)) await removeFixture(root)
})

it('launches the real CLI daemon through the independent hidden-console wrapper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch runner-survival-'))
  fixtureRoots.push(root)
  const probeFile = join(root, 'spawn-probe.jsonl')
  const preload = join(root, 'spawn-probe.cjs')
  const stopFile = join(root, 'orchestration', 'queue', 'stop')
  let daemonPid = 0
  testProcesses.trackPid(() => daemonPid, { tree: true })

  const init = spawnSync('git', ['init', '--initial-branch=main'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
  expect(init.status).toBe(0)
  writeFileSync(preload, [
    "const childProcess = require('node:child_process')",
    "const { appendFileSync } = require('node:fs')",
    "const { syncBuiltinESMExports } = require('node:module')",
    'const originalSpawn = childProcess.spawn',
    'childProcess.spawn = function (command, args, options) {',
    '  appendFileSync(process.env.ORCH_TEST_SPAWN_PROBE, `${JSON.stringify({',
    '    command,',
    '    args,',
    '    cwd: options?.cwd,',
    '    detached: options?.detached === true,',
    "    hasWindowsHide: Object.hasOwn(options ?? {}, 'windowsHide'),",
    '    windowsHide: options?.windowsHide,',
    '  })}\\n`)',
    '  return originalSpawn.apply(this, arguments)',
    '}',
    'syncBuiltinESMExports()',
    '',
  ].join('\n'))

  const launcher = spawnSync(process.execPath, [
    CLI, 'loop', '--approve-mode', 'local', '--daemon',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...environmentWithoutRestartHandover(),
      AUTO_PR: 'false',
      CORE_AUTO_UPDATE: 'false',
      ISSUE_QUEUE_ENABLED: 'false',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require="${preload.replaceAll('\\', '\\\\')}"`.trim(),
      ORCH_TEST_SPAWN_PROBE: probeFile,
      POLL_INTERVAL: '1',
      PROJECT: 'shiora',
      PROJECT_ADAPTER,
      REVIEW_ENABLED: 'false',
      SCAN_ENABLED: 'false',
    },
    timeout: 10_000,
    windowsHide: true,
  })
  expect(launcher.status, launcher.stderr).toBe(0)
  const match = /Started the loop in the background \(PID=(\d+)\)/.exec(launcher.stdout)
  expect(match).not.toBeNull()
  daemonPid = Number(match?.[1])

  await waitUntil(() => processIsAlive(daemonPid), 'CLI daemon did not survive its launcher')
  const probes = readFileSync(probeFile, 'utf8').trim().split(/\r?\n/)
    .map((line) => JSON.parse(line) as SpawnProbe)
  const daemonSpawn = probes.find((probe) => probe.command === process.execPath
    && probe.args.includes('--marker-output'))
  if (process.platform === 'win32') {
    // The wrapper owns the independent hidden console. The daemon is deliberately
    // attached to it so every console tool in the daemon tree inherits that console.
    expect(daemonSpawn).toMatchObject({ detached: false, hasWindowsHide: false })
  } else {
    expect(daemonSpawn).toMatchObject({
      detached: true,
      hasWindowsHide: true,
      windowsHide: true,
    })
  }
  // The daemon must inherit the repository the launcher was pointed at. Started in the
  // package directory instead, it resolves its own checkout as the repository and the
  // startup dependency install reinstalls the package it is running from.
  expect(resolve(daemonSpawn?.cwd ?? '').toLowerCase())
    .toBe(realpathSync.native(root).toLowerCase())

  mkdirSync(dirname(stopFile), { recursive: true })
  writeFileSync(stopFile, '')
  await waitUntil(() => !processIsAlive(daemonPid), 'CLI daemon did not stop')
})

it('does not pass consumed restart handover variables to child processes', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch runner-survival-'))
  fixtureRoots.push(root)
  const readyFile = join(root, 'restart.ready')
  const inheritedEnvironmentFile = join(root, 'inherited-environment.json')
  const script = join(root, 'signal-and-spawn.ts')
  const probe = join(root, 'environment-probe.cjs')
  writeFileSync(probe, [
    "const { writeFileSync } = require('node:fs')",
    'writeFileSync(process.argv[2], JSON.stringify({',
    '  readyFile: process.env.ORCHESTRATION_LOOP_RESTART_READY_FILE,',
    '  predecessorPid: process.env.ORCHESTRATION_LOOP_RESTART_PREDECESSOR_PID,',
    '}))',
    '',
  ].join('\n'))
  writeFileSync(script, [
    "import { spawnSync } from 'node:child_process'",
    `import { signalLoopRestartReady } from ${JSON.stringify(
      pathToFileURL(CLI.replace(/cli\.ts$/, 'restart.ts')).href,
    )}`,
    'signalLoopRestartReady()',
    `const child = spawnSync(process.execPath, [${JSON.stringify(probe)}, ${JSON.stringify(
      inheritedEnvironmentFile,
    )}])`,
    'if (child.status !== 0) process.exit(child.status ?? 1)',
    '',
  ].join('\n'))

  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...environmentWithoutRestartHandover(),
      [LOOP_RESTART_READY_FILE_ENV]: readyFile,
      [LOOP_RESTART_PREDECESSOR_PID_ENV]: `${process.pid}`,
    },
    windowsHide: true,
  })

  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(readyFile, 'utf8')).toMatch(/^\d+\n$/)
  expect(JSON.parse(readFileSync(inheritedEnvironmentFile, 'utf8'))).toEqual({})
})
