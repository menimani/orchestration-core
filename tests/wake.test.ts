import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { waitForNextPoll } from '../src/wake.ts'

let repoRoot: string
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-wake-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('waitForNextPoll', () => {
  it('wakes promptly when the backlog is appended', async () => {
    const startedAt = Date.now()
    const waiting = waitForNextPoll(paths, 5)

    appendFileSync(join(paths.queueDir, 'backlog.txt'), 'queued-task:0\n')

    await expect(waiting).resolves.toBe('woken')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('times out when the backlog does not change', async () => {
    await expect(waitForNextPoll(paths, 0.05)).resolves.toBe('timeout')
  })

  it('disposes the watcher after resolving', async () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const waiting = waitForNextPoll(paths, 5)
    appendFileSync(backlog, 'first-task:0\n')
    await expect(waiting).resolves.toBe('woken')

    appendFileSync(backlog, 'second-task:0\n')
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
})
