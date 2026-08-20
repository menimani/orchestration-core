import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ renameSync: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  renameSync: mocks.renameSync,
}))

import { writeConfigFile } from '../src/configFile.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  mocks.renameSync.mockReset()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('writeConfigFile', () => {
  it('never publishes a partial file and removes its temporary file when rename fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orch-config-write-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'config.json')
    writeFileSync(filePath, '{"MAX_PARALLEL":3}\n')
    mocks.renameSync.mockImplementation((temporary: string) => {
      expect(readFileSync(filePath, 'utf8')).toBe('{"MAX_PARALLEL":3}\n')
      expect(JSON.parse(readFileSync(temporary, 'utf8'))).toEqual({ MAX_PARALLEL: 8 })
      throw new Error('rename failed')
    })

    expect(() => writeConfigFile(filePath, { MAX_PARALLEL: 8 })).toThrow('rename failed')

    expect(readFileSync(filePath, 'utf8')).toBe('{"MAX_PARALLEL":3}\n')
    expect(readdirSync(directory)).toEqual(['config.json'])
  })
})
