import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { resolveFleetProject } from '../src/fleet.ts'
import { readJsonFile } from '../src/jsonFile.ts'

// PowerShell 5.1 `Set-Content -Encoding UTF8` writes these three bytes before the text.
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-json-file-'))
  roots.push(dir)
  return dir
}

function writeJsonWithBom(file: string, value: unknown): void {
  writeFileSync(file, Buffer.concat([UTF8_BOM, Buffer.from(`${JSON.stringify(value, null, 2)}\r\n`)]))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('readJsonFile', () => {
  it('parses a file that begins with a UTF-8 byte order mark', () => {
    const file = join(tempDir(), 'with-bom.json')
    writeJsonWithBom(file, { projects: {} })

    expect(readFileSync(file).subarray(0, 3)).toEqual(UTF8_BOM)
    expect(readJsonFile(file)).toEqual({ projects: {} })
  })

  it('parses a file without a byte order mark unchanged', () => {
    const file = join(tempDir(), 'plain.json')
    writeFileSync(file, '{"MAX_PARALLEL":3}\n')

    expect(readJsonFile(file)).toEqual({ MAX_PARALLEL: 3 })
  })

  it('still rejects a byte order mark that is not at the start', () => {
    const file = join(tempDir(), 'inner-bom.json')
    writeFileSync(file, Buffer.concat([Buffer.from(' '), UTF8_BOM, Buffer.from('{}')]))

    expect(() => readJsonFile(file)).toThrow(SyntaxError)
  })
})

describe('hand-written files saved with a byte order mark', () => {
  it('resolves a fleet project from fleet.json and fleet.local.json', () => {
    const dir = tempDir()
    writeJsonWithBom(join(dir, 'fleet.json'), { projects: { example: { repository: 'owner/example' } } })
    writeJsonWithBom(join(dir, 'fleet.local.json'), { projects: { example: { path: '../example' } } })

    expect(resolveFleetProject(dir, 'example').checkout).toBe(join(dir, '..', 'example'))
  })

  it('loads the configuration file', () => {
    const filePath = join(tempDir(), 'config.json')
    writeJsonWithBom(filePath, { MAX_PARALLEL: 2 })

    expect(loadConfig({}, { filePath, onEvent: () => {} }).maxParallel).toBe(2)
  })
})
