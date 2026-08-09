import type { Forge, PrCheck } from './adapters/forge.ts'

const POLL_INTERVAL_MS = 30_000

export interface CiWaitOptions {
  timeoutSeconds: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  print?: (line: string) => void
}

function newestChecksByName(checks: PrCheck[]): PrCheck[] {
  const newest = new Map<string, PrCheck>()
  for (const check of checks) {
    const previous = newest.get(check.name)
    if (previous === undefined || check.startedAt >= previous.startedAt) {
      newest.set(check.name, check)
    }
  }
  return [...newest.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function sameNames(left: string[] | undefined, right: string[]): boolean {
  return left !== undefined
    && left.length === right.length
    && left.every((name, index) => name === right[index])
}

export async function waitForCi(
  forge: Forge,
  prNumber: number,
  options: CiWaitOptions,
): Promise<number> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  }))
  const print = options.print ?? console.log
  const deadline = now() + options.timeoutSeconds * 1_000
  let previousNames: string[] | undefined

  for (;;) {
    const status = await forge.prStatus(String(prNumber))
    const checks = newestChecksByName(status.checks)
    const names = checks.map((check) => check.name)
    const eligible = status.state === 'open' && checks.length > 0
    const ready = eligible
      && sameNames(previousNames, names)
      && checks.every((check) => check.conclusion !== 'pending')

    if (ready) {
      for (const check of checks) print(`${check.name}: ${check.conclusion}`)
      return checks.some((check) => check.conclusion === 'failure') ? 1 : 0
    }

    previousNames = eligible ? names : undefined
    const remaining = deadline - now()
    if (remaining <= 0) return 2
    if (remaining < POLL_INTERVAL_MS) {
      await sleep(remaining)
      return 2
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
