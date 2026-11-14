import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  markStartupInstalling, startupDeadline, startupInstallingFile,
} from '../src/startupInstall.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orch-startup-install-'))
  fixtureRoots.push(root)
  return root
}

describe('startup install announcement', () => {
  it('announces to every launcher and clears every announcement', () => {
    const root = fixtureRoot()
    const started = join(root, 'started.json')
    const restarted = join(root, 'restart.ready')

    const clear = markStartupInstalling([started, undefined, '', restarted])

    expect(readdirSync(root).sort()).toEqual([
      'restart.ready.installing', 'started.json.installing',
    ])
    clear()
    expect(readdirSync(root)).toEqual([])
  })

  it('restarts the full timeout while an install is announced', () => {
    const readinessFile = join(fixtureRoot(), 'ready')
    // An install that began at startup is still running long after the original
    // deadline; the launcher must keep waiting rather than kill it mid-install.
    const clear = markStartupInstalling([readinessFile])

    expect(startupDeadline(readinessFile, 1_000, 30_000, 90_000)).toBe(120_000)
    expect(startupDeadline(readinessFile, 200_000, 30_000, 90_000)).toBe(200_000)

    clear()
    expect(existsSync(startupInstallingFile(readinessFile))).toBe(false)
    expect(startupDeadline(readinessFile, 1_000, 30_000, 90_000)).toBe(1_000)
  })
})
