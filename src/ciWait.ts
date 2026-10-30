import { ForgeRateLimitError, type Forge, type PrCheck, type PrStatus } from './adapters/forge.ts'

const POLL_INTERVAL_MS = 30_000

export interface CiWaitOptions {
  timeoutSeconds: number
  // Right after a push the forge can still report the previous head with finished
  // checks, so only checks reported for this commit can yield a verdict.
  expectedHead: string
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  print?: (line: string) => void
  warn?: (line: string) => void
}

export function newestChecksByName(checks: PrCheck[]): PrCheck[] {
  const byName = new Map<string, PrCheck[]>()
  for (const check of checks) {
    const named = byName.get(check.name) ?? []
    named.push(check)
    byName.set(check.name, named)
  }
  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, named]) => {
      const dated = named.flatMap((check) => {
        const timestamp = Date.parse(check.startedAt)
        return Number.isFinite(timestamp) ? [{ check, timestamp }] : []
      })
      const newestTimestamp = dated.reduce<number | undefined>((newest, { timestamp }) =>
        newest === undefined || timestamp > newest ? timestamp : newest, undefined)
      // An absent/invalid timestamp cannot prove that a result supersedes another run.
      // Preserve every such result, plus every dated result tied for newest, so an
      // arbitrarily ordered success cannot hide a conflicting failure or pending run.
      return named.filter((check) => {
        const timestamp = Date.parse(check.startedAt)
        return !Number.isFinite(timestamp) || timestamp === newestTimestamp
      })
    })
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
  const warn = options.warn ?? console.error
  const deadline = now() + options.timeoutSeconds * 1_000
  let previousNames: string[] | undefined
  let lastWindowSlept = false

  for (;;) {
    let status: PrStatus | undefined
    let wait = POLL_INTERVAL_MS
    try {
      status = await forge.prStatus({ kind: 'number', value: prNumber })
    } catch (error) {
      // A failed poll says nothing about the checks, so it must not read as a failed
      // check; it also breaks the run of polls whose check names must match.
      warn(`ci-wait: forge poll failed: ${error instanceof Error ? error.message : String(error)}`)
      if (error instanceof ForgeRateLimitError) {
        const untilReset = error.resetAt.getTime() - now()
        // No poll can succeed before the reset, so one at or past the deadline leaves
        // nothing worth waiting for.
        if (untilReset >= deadline - now()) return 3
        wait = Math.max(wait, untilReset)
      }
    }

    if (status === undefined) {
      previousNames = undefined
    } else {
      const checks = newestChecksByName(status.checks)
      const names = checks.map((check) => check.name)
      const eligible = status.state === 'open'
        && status.headSha !== ''
        && status.headSha === options.expectedHead
        && checks.length > 0
      const ready = eligible
        && sameNames(previousNames, names)
        && checks.every((check) => check.conclusion !== 'pending')

      if (ready) {
        for (const check of checks) print(`${check.name}: ${check.conclusion}`)
        return checks.some((check) => check.conclusion === 'failure') ? 1 : 0
      }

      previousNames = eligible ? names : undefined
    }
    const remaining = deadline - now()
    // The budget is spent only once the last window has been both slept and polled.
    // A spent budget whose last poll failed has no observation to report at all.
    if (lastWindowSlept || remaining <= 0) return status === undefined ? 3 : 2
    if (remaining < wait) {
      // Spend what is left of the budget, then poll once more: a result that settles
      // inside this last window is a verdict, not a timeout, and a timeout below one
      // interval would otherwise never reach the second poll that stable names need.
      lastWindowSlept = true
      await sleep(remaining)
      continue
    }
    await sleep(wait)
  }
}
