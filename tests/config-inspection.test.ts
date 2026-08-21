import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ inspectionError: undefined as Error | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (mocks.inspectionError !== undefined) throw mocks.inspectionError
      return actual.statSync(...args)
    },
  }
})

import { loadConfig } from '../src/config.ts'

let temporaryDirectory: string | undefined

afterEach(() => {
  mocks.inspectionError = undefined
  if (temporaryDirectory !== undefined) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

describe('loadConfig inspection failures', () => {
  it('stops serving stale values after a non-ENOENT inspection failure', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'orch-config-inspection-'))
    const filePath = join(temporaryDirectory, 'config.json')
    writeFileSync(filePath, JSON.stringify({ MAX_PARALLEL: 6 }))
    const events: string[] = []
    const config = loadConfig({}, {
      filePath,
      onEvent: (event) => events.push(event.message),
    })
    expect(config.maxParallel).toBe(6)

    const error = Object.assign(new Error('access denied'), { code: 'EACCES' })
    mocks.inspectionError = error

    expect(() => config.maxParallel).toThrow(`Could not inspect ${filePath}: access denied`)
    expect(() => config.maxParallel).toThrow(`Could not inspect ${filePath}: access denied`)
    expect(events).toEqual([`Could not inspect ${filePath}: access denied`])
  })
})
