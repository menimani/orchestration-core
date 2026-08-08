import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { orchPaths, type OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'

// The command surface: each package.json script dispatches here with the command name
// as the first argument. Commands are registered as they are ported from bin/*.sh; an
// unported name fails loudly with the list of what exists, so nothing pretends to work.

type Command = (paths: OrchPaths, args: string[]) => Promise<number>

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const loopStatus: Command = async (paths) => {
  const pidFile = join(paths.queueDir, 'loop.pid')
  let running = false
  let pid = ''
  if (existsSync(pidFile)) {
    pid = readFileSync(pidFile, 'utf8').trim()
    running = /^\d+$/.test(pid) && isPidAlive(Number(pid))
  }
  console.log(running ? `loop: running (PID=${pid})` : 'loop: not running')

  const backlogFile = join(paths.queueDir, 'backlog.txt')
  const queued = existsSync(backlogFile)
    ? readFileSync(backlogFile, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    : []
  console.log(queued.length === 0
    ? 'queued: none'
    : `queued: ${queued.map((line) => line.split(':')[0]).join(', ')}`)

  console.log('in flight:')
  const { readdirSync } = await import('node:fs')
  const inFlight = readdirSync(paths.statusDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readStatus(paths, name.replace(/\.json$/, '')))
    .filter((status) => status !== undefined && status.status === 'running'
      && status.pid !== null && isPidAlive(status.pid))
  if (inFlight.length === 0) {
    console.log('  (nothing)')
  } else {
    for (const status of inFlight) {
      console.log(`  ${status?.task_id} (pid=${status?.pid})`)
    }
  }
  return 0
}

const commands: Record<string, Command> = {
  'loop-status': loopStatus,
}

async function main(): Promise<number> {
  const [commandName, ...args] = process.argv.slice(2)
  if (commandName === undefined || commandName === '') {
    console.error(`Usage: npm run <command>\nAvailable: ${Object.keys(commands).join(', ')}`)
    return 1
  }
  const command = commands[commandName]
  if (command === undefined) {
    // Two different situations end up here, and only one of them is transitional.
    // While the bash implementation is still in the tree, a name it knows is simply
    // not ported yet, and pointing at it helps. Once the cutover has deleted it, a
    // name reaching this branch is a missing or mistyped command, and the last thing
    // the message may do is recommend a file that no longer exists.
    const bashEntry = join(repoRoot(), 'orchestration', 'orchestrate.sh')
    if (existsSync(bashEntry)) {
      console.error(`Not ported yet: '${commandName}'. Until the cutover, run:`)
      console.error(`  ${bashEntry} ${commandName}`)
    } else {
      console.error(`Unknown command: '${commandName}'.`)
    }
    console.error(`Available commands: ${Object.keys(commands).join(', ')}`)
    return 1
  }
  return command(orchPaths(repoRoot()), args)
}

process.exitCode = await main()
