import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  fakeForge, forgeStatus, makeLoop, paths, registerLoopHooks, setForgeStatus, stubProject,
  useFakeRepository,
} from './loopHarness.ts'

// Loop decisions that need git only to say what HEAD is, asked of an in-memory checkout
// (tests/fakeRepository.ts) instead of a fixture repository. They share loop.test.ts's
// describe titles; the tests there that need a real repository stay there.

registerLoopHooks()

describe('checkPrCiStatus', () => {
  let headSha: string

  beforeEach(() => {
    headSha = useFakeRepository().state.head
    writeFileSync(join(paths.queueDir, 'pr-url.txt'), 'https://example.test/pull/1\n')
  })

  it('passes on all-success and fails on any failure', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [
      { name: 'a', conclusion: 'success', startedAt: '' },
      { name: 'b', conclusion: 'success', startedAt: '' },
    ]
    expect(await loop.checkPrCiStatus()).toBe('pending')
    expect(await loop.checkPrCiStatus()).toBe('success')
    expect(fakeForge.prStatusRefs).toEqual([
      { kind: 'url', value: 'https://example.test/pull/1' },
      { kind: 'url', value: 'https://example.test/pull/1' },
    ])
    forgeStatus.checks = [{ name: 'a', conclusion: 'failure', startedAt: '' }]
    expect(await loop.checkPrCiStatus()).toBe('pending')
    expect(await loop.checkPrCiStatus()).toBe('failure')
  })

  it('keeps waiting on mixed pending and failed checks', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [
      { name: 'a', conclusion: 'pending', startedAt: '' },
      { name: 'b', conclusion: 'failure', startedAt: '' },
    ]
    expect(await loop.checkPrCiStatus()).not.toBe('success')
  })

  it('uses the newest rerun of each check name', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [
      { name: 'frontend', conclusion: 'success', startedAt: '2026-08-14T02:00:00Z' },
      { name: 'frontend', conclusion: 'failure', startedAt: '2026-08-14T01:00:00Z' },
      { name: 'backend', conclusion: 'success', startedAt: '2026-08-14T01:30:00Z' },
    ]

    expect(await loop.checkPrCiStatus()).toBe('pending')
    expect(await loop.checkPrCiStatus()).toBe('success')
  })

  it.each([
    ['without timestamps', ''],
    ['with tied timestamps', '2026-08-14T02:00:00Z'],
  ])('does not let an arbitrarily ordered success hide a same-name failure %s',
    async (_description, startedAt) => {
      const loop = makeLoop()
      forgeStatus.checks = [
        { name: 'frontend', conclusion: 'failure', startedAt },
        { name: 'frontend', conclusion: 'success', startedAt },
      ]

      expect(await loop.checkPrCiStatus()).toBe('pending')
      expect(await loop.checkPrCiStatus()).toBe('failure')
    })

  it.each([
    ['a passed', 'success', 'success'],
    ['a failed', 'failure', 'failure'],
  ] as const)('waits while the forge still reports %s earlier head', async (_description, conclusion, verdict) => {
    const loop = makeLoop()
    setForgeStatus({
      ...forgeStatus,
      headSha: 'f'.repeat(40),
      checks: [{ name: 'a', conclusion, startedAt: '' }],
    })
    expect(await loop.checkPrCiStatus()).toBe('pending')

    setForgeStatus({ ...forgeStatus, headSha })
    expect(await loop.checkPrCiStatus()).toBe('pending')
    expect(await loop.checkPrCiStatus()).toBe(verdict)
  })

  it('waits for a check that appears only after the listed ones finish', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [{ name: 'build', conclusion: 'success', startedAt: '' }]
    expect(await loop.checkPrCiStatus()).toBe('pending')

    forgeStatus.checks = [
      { name: 'build', conclusion: 'success', startedAt: '' },
      { name: 'deploy', conclusion: 'failure', startedAt: '' },
    ]
    expect(await loop.checkPrCiStatus()).toBe('pending')
    expect(await loop.checkPrCiStatus()).toBe('failure')
  })

  it('needs the check names again after a failed status read', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [{ name: 'a', conclusion: 'success', startedAt: '' }]
    expect(await loop.checkPrCiStatus()).toBe('pending')
    const prStatus = fakeForge.prStatus
    fakeForge.prStatus = async () => { throw new Error('checks unavailable') }
    expect(await loop.checkPrCiStatus()).toBe('unknown')
    fakeForge.prStatus = prStatus

    expect(await loop.checkPrCiStatus()).toBe('pending')
    expect(await loop.checkPrCiStatus()).toBe('success')
  })

  it('gives a verdict when the second poll lists the same checks in another order', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [
      { name: 'build', conclusion: 'success', startedAt: '' },
      { name: 'lint', conclusion: 'success', startedAt: '' },
      { name: 'test', conclusion: 'failure', startedAt: '' },
    ]
    expect(await loop.checkPrCiStatus()).toBe('pending')

    forgeStatus.checks = [
      { name: 'test', conclusion: 'failure', startedAt: '' },
      { name: 'build', conclusion: 'success', startedAt: '' },
      { name: 'lint', conclusion: 'success', startedAt: '' },
    ]
    expect(await loop.checkPrCiStatus()).toBe('failure')
  })

  it.each([
    ['a name is added', ['b', 'a'], ['c', 'a', 'b']],
    ['a name is removed', ['c', 'a', 'b'], ['b', 'a']],
    ['a name listed twice is listed once', ['b', 'a', 'b'], ['b', 'a']],
    ['a name listed once is listed twice', ['b', 'a'], ['b', 'a', 'b']],
  ])('stays pending for the poll on which %s', async (_description, first, second) => {
    const loop = makeLoop()
    forgeStatus.checks = first.map((name) => ({ name, conclusion: 'success', startedAt: '' }))
    expect(await loop.checkPrCiStatus()).toBe('pending')

    forgeStatus.checks = second.map((name) => ({ name, conclusion: 'success', startedAt: '' }))
    expect(await loop.checkPrCiStatus()).toBe('pending')
    forgeStatus.checks = [...second].reverse()
      .map((name) => ({ name, conclusion: 'success', startedAt: '' }))
    expect(await loop.checkPrCiStatus()).toBe('success')
  })

  it('does not clear the gate for an old PR head with no checks', async () => {
    setForgeStatus({ ...forgeStatus, headSha, checks: [] })
    const loop = makeLoop({}, stubProject, undefined, () => new Date('2030-01-01T00:00:00Z'))
    expect(await loop.checkPrCiStatus()).toBe('unknown')
  })

  it('passes with no checks only when the project explicitly expects none', async () => {
    const loop = makeLoop({}, { ...stubProject, ciChecksExpected: false })
    forgeStatus.checks = []
    expect(await loop.checkPrCiStatus()).toBe('success')
  })
})
