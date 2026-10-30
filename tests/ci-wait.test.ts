import { describe, expect, it } from 'vitest'
import { ForgeRateLimitError, type CheckConclusion, type PrStatus } from '../src/adapters/forge.ts'
import { normalizeEntry } from '../src/adapters/forge-github.ts'
import { waitForCi } from '../src/ciWait.ts'
import { makeFakeForge } from './fakeForge.ts'

function status(checks: Array<[string, CheckConclusion, string]>): PrStatus {
  return {
    state: 'open',
    isDraft: false,
    url: 'https://example.test/pull/42',
    headSha: 'head',
    checks: checks.map(([name, conclusion, startedAt]) => ({ name, conclusion, startedAt })),
  }
}

function scriptedWait(statuses: PrStatus[]): {
  run: () => Promise<number>
  output: string[]
  sleeps: number[]
  forge: ReturnType<typeof makeFakeForge>
} {
  const forge = makeFakeForge()
  forge.prStatusScript = statuses
  const output: string[] = []
  const sleeps: number[] = []
  let time = 0
  return {
    forge,
    output,
    sleeps,
    run: () => waitForCi(forge, 42, {
      timeoutSeconds: 900,
      expectedHead: 'head',
      now: () => time,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        time += milliseconds
      },
      print: (line) => output.push(line),
    }),
  }
}

describe('CI wait', () => {
  it('uses the newest run when a stale failure has the same check name', async () => {
    const checks = status([
      ['test', 'failure', '2026-08-09T01:00:00Z'],
      ['test', 'success', '2026-08-09T01:01:00Z'],
      ['optional', 'skipped', '2026-08-09T01:01:00Z'],
    ])
    const wait = scriptedWait([checks, checks])

    await expect(wait.run()).resolves.toBe(0)
    expect(wait.forge.prStatusRefs).toEqual([
      { kind: 'number', value: 42 },
      { kind: 'number', value: 42 },
    ])
    expect(wait.output).toEqual(['optional: skipped', 'test: success'])
  })

  it.each([
    ['without timestamps', ''],
    ['with tied timestamps', '2026-08-09T01:00:00Z'],
  ])('preserves a same-name failure when a success follows it %s',
    async (_description, startedAt) => {
      const checks = status([
        ['test', 'failure', startedAt],
        ['test', 'success', startedAt],
      ])
      const wait = scriptedWait([checks, checks])

      await expect(wait.run()).resolves.toBe(1)
      expect(wait.output).toEqual(['test: failure', 'test: success'])
    })

  it('delays the verdict until check names are stable across two polls', async () => {
    const wait = scriptedWait([
      status([['test', 'success', '2026-08-09T01:00:00Z']]),
      status([
        ['lint', 'success', '2026-08-09T01:00:30Z'],
        ['test', 'success', '2026-08-09T01:00:00Z'],
      ]),
      status([
        ['lint', 'success', '2026-08-09T01:00:30Z'],
        ['test', 'success', '2026-08-09T01:00:00Z'],
      ]),
    ])

    await expect(wait.run()).resolves.toBe(0)
    expect(wait.forge.prStatusCalls).toBe(3)
    expect(wait.sleeps).toEqual([30_000, 30_000])
  })

  it('returns failure for a stable genuine failure', async () => {
    const checks = status([['test', 'failure', '2026-08-09T01:00:00Z']])
    const wait = scriptedWait([checks, checks])

    await expect(wait.run()).resolves.toBe(1)
    expect(wait.output).toEqual(['test: failure'])
  })

  it.each(['ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])(
    'returns failure for a stable completed %s check',
    async (conclusion) => {
      const normalized = normalizeEntry({ status: 'COMPLETED', conclusion })
      const checks = status([['test', normalized, '2026-08-09T01:00:00Z']])
      const wait = scriptedWait([checks, checks])

      await expect(wait.run()).resolves.toBe(1)
      expect(wait.output).toEqual(['test: failure'])
    },
  )

  it('waits for a non-empty check rollup before returning a verdict', async () => {
    const checks = status([['test', 'success', '2026-08-09T01:00:00Z']])
    const wait = scriptedWait([status([]), status([]), checks, checks])

    await expect(wait.run()).resolves.toBe(0)
    expect(wait.forge.prStatusCalls).toBe(4)
    expect(wait.sleeps).toEqual([30_000, 30_000, 30_000])
  })

  it('waits for an open PR before returning a verdict', async () => {
    const checks = status([['test', 'success', '2026-08-09T01:00:00Z']])
    const missing = { ...checks, state: 'none' as const }
    const wait = scriptedWait([missing, missing, checks, checks])

    await expect(wait.run()).resolves.toBe(0)
    expect(wait.forge.prStatusCalls).toBe(4)
    expect(wait.sleeps).toEqual([30_000, 30_000, 30_000])
  })

  it('waits for the PR to report the expected head before returning a verdict', async () => {
    const checks = status([['test', 'success', '2026-08-09T01:00:00Z']])
    const stale = { ...status([['test', 'failure', '2026-08-09T00:00:00Z']]), headSha: 'previous' }
    const unreported = { ...checks, headSha: '' }
    const wait = scriptedWait([stale, stale, unreported, unreported, checks, checks])

    await expect(wait.run()).resolves.toBe(0)
    expect(wait.forge.prStatusCalls).toBe(6)
    expect(wait.output).toEqual(['test: success'])
  })

  it('returns timeout when a verdict does not become ready', async () => {
    const forge = makeFakeForge()
    forge.prStatusValue = status([['test', 'pending', '2026-08-09T01:00:00Z']])
    const sleeps: number[] = []
    let time = 0

    await expect(waitForCi(forge, 42, {
      timeoutSeconds: 45,
      expectedHead: 'head',
      now: () => time,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        time += milliseconds
      },
    })).resolves.toBe(2)
    expect(forge.prStatusCalls).toBe(3)
    expect(sleeps).toEqual([30_000, 15_000])
  })

  it('polls once more after the shortened last sleep', async () => {
    const forge = makeFakeForge()
    forge.prStatusScript = [
      status([['test', 'pending', '2026-08-09T01:00:00Z']]),
      status([['test', 'pending', '2026-08-09T01:00:00Z']]),
      status([['test', 'success', '2026-08-09T01:00:00Z']]),
    ]
    const output: string[] = []
    let time = 0

    await expect(waitForCi(forge, 42, {
      timeoutSeconds: 45,
      expectedHead: 'head',
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds },
      print: (line) => output.push(line),
    })).resolves.toBe(0)
    expect(forge.prStatusCalls).toBe(3)
    expect(output).toEqual(['test: success'])
  })

  it('reaches a verdict with a timeout shorter than one poll interval', async () => {
    const checks = status([['test', 'failure', '2026-08-09T01:00:00Z']])
    const forge = makeFakeForge()
    forge.prStatusValue = checks
    const sleeps: number[] = []
    let time = 0

    await expect(waitForCi(forge, 42, {
      timeoutSeconds: 10,
      expectedHead: 'head',
      now: () => time,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        time += milliseconds
      },
    })).resolves.toBe(1)
    expect(forge.prStatusCalls).toBe(2)
    expect(sleeps).toEqual([10_000])
  })

  function failingWait(outcomes: Array<PrStatus | Error>, timeoutSeconds: number): {
    run: () => Promise<number>
    output: string[]
    warnings: string[]
    sleeps: number[]
    polls: () => number
  } {
    const forge = makeFakeForge()
    let polls = 0
    forge.prStatus = async () => {
      const outcome = outcomes[Math.min(polls, outcomes.length - 1)]!
      polls++
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    const output: string[] = []
    const warnings: string[] = []
    const sleeps: number[] = []
    let time = 0
    return {
      output,
      warnings,
      sleeps,
      polls: () => polls,
      run: () => waitForCi(forge, 42, {
        timeoutSeconds,
        expectedHead: 'head',
        now: () => time,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          time += milliseconds
        },
        print: (line) => output.push(line),
        warn: (line) => warnings.push(line),
      }),
    }
  }

  it('keeps polling past a failed forge call and needs two stable polls after it', async () => {
    const checks = status([['test', 'success', '2026-08-09T01:00:00Z']])
    const wait = failingWait([checks, new Error('HTTP 502'), checks, checks], 900)

    await expect(wait.run()).resolves.toBe(0)
    expect(wait.polls()).toBe(4)
    expect(wait.sleeps).toEqual([30_000, 30_000, 30_000])
    expect(wait.output).toEqual(['test: success'])
    expect(wait.warnings).toEqual(['ci-wait: forge poll failed: HTTP 502'])
  })

  it('sleeps until the rate limit resets before polling again', async () => {
    const checks = status([['test', 'success', '2026-08-09T01:00:00Z']])
    const wait = failingWait([new ForgeRateLimitError(new Date(120_000)), checks, checks], 900)

    await expect(wait.run()).resolves.toBe(0)
    expect(wait.polls()).toBe(3)
    expect(wait.sleeps).toEqual([120_000, 30_000])
  })

  it('exits 3 without waiting when the rate limit resets past the deadline', async () => {
    const wait = failingWait([new ForgeRateLimitError(new Date(900_000))], 900)

    await expect(wait.run()).resolves.toBe(3)
    expect(wait.polls()).toBe(1)
    expect(wait.sleeps).toEqual([])
  })

  it('exits 3 when the budget runs out after a failed last poll', async () => {
    const pending = status([['test', 'pending', '2026-08-09T01:00:00Z']])
    const wait = failingWait([pending, pending, new Error('socket hang up')], 45)

    await expect(wait.run()).resolves.toBe(3)
    expect(wait.polls()).toBe(3)
    expect(wait.sleeps).toEqual([30_000, 15_000])
    expect(wait.output).toEqual([])
  })

  it('exits 2 when the last poll succeeds after an earlier failure', async () => {
    const pending = status([['test', 'pending', '2026-08-09T01:00:00Z']])
    const wait = failingWait([new Error('HTTP 503'), pending, pending], 45)

    await expect(wait.run()).resolves.toBe(2)
    expect(wait.polls()).toBe(3)
  })
})
