import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepStaleFixtures } from './fixtureSweep.ts'

// Fixed for the file, but taken from the real clock: a fresh directory's mtime is the
// real time, and must count as new against this instant.
const NOW = Date.now()
const SEVEN_HOURS_AGO = new Date(NOW - 7 * 60 * 60 * 1000)

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

function makeAged(name: string, nested = ''): string {
  const path = join(root, name)
  mkdirSync(join(path, nested), { recursive: true })
  utimesSync(path, SEVEN_HOURS_AGO, SEVEN_HOURS_AGO)
  return path
}

describe('stale fixture sweep', () => {
  it('removes only this suite\'s fixtures older than six hours', () => {
    root = mkdtempSync(join(tmpdir(), 'fixture-sweep-'))
    makeAged('orch-old-a')
    makeAged('orch runner-survival-b', join('orchestration', 'queue'))
    makeAged('orchestration-shell-c')
    makeAged('orchestration-windows-launch-d')
    mkdirSync(join(root, 'orch-new-e'))
    makeAged('other-old-f')

    expect(sweepStaleFixtures(root, NOW)).toBe(4)

    expect(existsSync(join(root, 'orch-old-a'))).toBe(false)
    expect(existsSync(join(root, 'orch runner-survival-b'))).toBe(false)
    expect(existsSync(join(root, 'orchestration-shell-c'))).toBe(false)
    expect(existsSync(join(root, 'orchestration-windows-launch-d'))).toBe(false)
    expect(existsSync(join(root, 'orch-new-e'))).toBe(true)
    expect(existsSync(join(root, 'other-old-f'))).toBe(true)
  })

  it('stops a held fixture and leaves it for a later run when it cannot be removed', () => {
    root = mkdtempSync(join(tmpdir(), 'fixture-sweep-'))
    const queueDir = join(root, 'orch runner-survival-g', 'orchestration', 'queue')
    mkdirSync(queueDir, { recursive: true })
    const descriptor = openSync(join(queueDir, 'held.log'), 'w')
    utimesSync(join(root, 'orch runner-survival-g'), SEVEN_HOURS_AGO, SEVEN_HOURS_AGO)

    try {
      let removed = -1
      expect(() => { removed = sweepStaleFixtures(root, NOW) }).not.toThrow()

      if (existsSync(join(root, 'orch runner-survival-g'))) {
        // Windows refuses to remove a file another handle holds open.
        expect(existsSync(join(queueDir, 'stop'))).toBe(true)
        expect(removed).toBe(0)
      } else {
        // POSIX unlinks an open file, so the fixture goes on the first sweep.
        expect(removed).toBe(1)
      }
    } finally {
      closeSync(descriptor)
    }
  })
})
