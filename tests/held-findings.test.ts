import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { heldFindingsFileName, readHeldFindings, writeHeldFindings } from '../src/heldFindings.ts'
import { createOrchDirectories, orchPaths, type OrchPaths } from '../src/paths.ts'

const lineSeparator = String.fromCodePoint(0x2028)
const paragraphSeparator = String.fromCodePoint(0x2029)
let repoRoot: string
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-held-'))
  paths = orchPaths(repoRoot)
  createOrchDirectories(paths)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('held findings', () => {
  it.each([
    ['an ordinary finding', '[DOCS] `README.md` names a removed flag'],
    ['an interior line separator', `[DOCS] README.md names${lineSeparator}a removed flag`],
    ['an interior paragraph separator', `[DOCS] README.md names${paragraphSeparator}a removed flag`],
    ['an interior lone carriage return', '[DOCS] `README.md` names\ra removed flag'],
  ])('reads back %s exactly as it was written', (_label, finding) => {
    const held = [
      { depth: 2, parentTaskId: '20250101_000000_001_scan', finding },
      { depth: 1, parentTaskId: '20250101_000000_002_scan', finding: '[DOCS] `SPEC.md` misstates a bound' },
    ]

    writeHeldFindings(paths, held)

    expect(readHeldFindings(paths)).toEqual(held)
  })

  it.each([
    ['a missing depth', '\t20250101_000000_001_scan\t[DOCS] `README.md` names a removed flag\n'],
    ['a missing parent task', '1\t\t[DOCS] `README.md` names a removed flag\n'],
    ['a missing finding', '1\t20250101_000000_001_scan\t\n'],
    ['no field separators', '1 20250101_000000_001_scan [DOCS] `README.md`\n'],
  ])('rejects a record with %s', (_label, record) => {
    writeFileSync(join(paths.queueDir, heldFindingsFileName), record)

    expect(() => readHeldFindings(paths)).toThrow(/Malformed held finding record/)
  })
})
