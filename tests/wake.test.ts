import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { observeNextPoll, signalWake } from '../src/wake.ts'

let repoRoot: string
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-wake-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('observeNextPoll', () => {
  it('wakes promptly when the backlog is appended', async () => {
    const startedAt = Date.now()
    const observation = observeNextPoll(paths, 5)

    appendFileSync(join(paths.queueDir, 'backlog.txt'), 'queued-task:0\n')

    await expect(observation.outcome).resolves.toBe('woken')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('times out when the backlog does not change', async () => {
    await expect(observeNextPoll(paths, 0.05).outcome).resolves.toBe('timeout')
  })

  it('disposes the watcher after resolving', async () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const observation = observeNextPoll(paths, 5)
    appendFileSync(backlog, 'first-task:0\n')
    await expect(observation.outcome).resolves.toBe('woken')

    appendFileSync(backlog, 'second-task:0\n')
    await new Promise((resolve) => setTimeout(resolve, 600))
  })

  it('retains an enqueue observed while the preceding poll is still returning', async () => {
    const observation = observeNextPoll(paths, 5)
    appendFileSync(join(paths.queueDir, 'backlog.txt'), 'between-poll-and-wait:0\n')

    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(observation.outcome).resolves.toBe('woken')
  })

  it('can be cancelled when the loop finishes without another poll', async () => {
    const observation = observeNextPoll(paths, 5)
    observation.cancel()

    await expect(observation.outcome).resolves.toBe('cancelled')
  })

  it('wakes on the wake signal, which forge-only work uses instead of the backlog', async () => {
    const observation = observeNextPoll(paths, 10)
    await new Promise((resolve) => setTimeout(resolve, 150))
    signalWake(paths)

    await expect(observation.outcome).resolves.toBe('woken')
  })
})
