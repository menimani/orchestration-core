import { describe, expect, it } from 'vitest'
import type { CheckConclusion, PrStatus } from '../src/adapters/forge.ts'
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

  it('returns timeout when a verdict does not become ready', async () => {
    const forge = makeFakeForge()
    forge.prStatusValue = status([['test', 'pending', '2026-08-09T01:00:00Z']])
    let time = 0

    await expect(waitForCi(forge, 42, {
      timeoutSeconds: 45,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds },
    })).resolves.toBe(2)
    expect(forge.prStatusCalls).toBe(2)
  })
})
