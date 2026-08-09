import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const INFO_ARGS = ['info', '--format', '{{.ServerVersion}}']

type RunCommand = (command: string, args: string[], timeout?: number) => boolean

interface DockerRuntime {
  run?: RunCommand
  launch?: (command: string) => void
  exists?: (path: string) => boolean
  delay?: (milliseconds: number) => Promise<void>
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  attempts?: number
}

function run(command: string, args: string[], timeout = 10_000): boolean {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
  })
  return result.status === 0
}

function launch(command: string): void {
  const child = spawn(command, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function ensureDocker(runtime: DockerRuntime = {}): Promise<void> {
  const execute = runtime.run ?? run
  const launchDetached = runtime.launch ?? launch
  const fileExists = runtime.exists ?? existsSync
  const pause = runtime.delay ?? delay
  const platform = runtime.platform ?? process.platform
  const environment = runtime.env ?? process.env
  const attempts = runtime.attempts ?? 24

  if (execute('docker', INFO_ARGS, 5_000)) return

  let startAttempted = execute('docker', ['desktop', 'start'], 120_000)

  if (!startAttempted && platform === 'win32') {
    const candidates = [
      environment['ProgramFiles'] === undefined
        ? undefined
        : join(environment['ProgramFiles'], 'Docker', 'Docker', 'Docker Desktop.exe'),
      environment['LOCALAPPDATA'] === undefined
        ? undefined
        : join(environment['LOCALAPPDATA'], 'Docker', 'Docker Desktop.exe'),
    ].filter((path): path is string => path !== undefined && fileExists(path))
    if (candidates[0] !== undefined) {
      launchDetached(candidates[0])
      startAttempted = true
    }
  } else if (!startAttempted && platform === 'darwin') {
    startAttempted = execute('open', ['-a', 'Docker'])
  } else if (!startAttempted && platform === 'linux') {
    startAttempted = execute('systemctl', ['start', 'docker'])
      || execute('sudo', ['-n', 'systemctl', 'start', 'docker'])
      || execute('service', ['docker', 'start'])
  }

  if (!startAttempted) {
    throw new Error(
      'Docker is unavailable. Install Docker Desktop or Docker Engine and allow this user to start it.',
    )
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await pause(5_000)
    if (execute('docker', INFO_ARGS, 5_000)) return
  }

  throw new Error('Docker was started but did not become ready within two minutes.')
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await ensureDocker()
    process.stdout.write('Docker is ready for Testcontainers.\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
