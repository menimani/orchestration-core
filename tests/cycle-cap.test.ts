import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type LoopConfig } from '../src/config.ts'
import { createCycleCapRecorder, type CycleCapRecorder } from '../src/cycleCap.ts'

let directory: string
let configFile: string
let capFile: string
let lines: string[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orch-cycle-cap-'))
  configFile = join(directory, 'config.json')
  capFile = join(directory, 'cycle-cap.txt')
  lines = []
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function setCap(cap: number): void {
  writeFileSync(configFile, JSON.stringify({ MAX_SCAN_CYCLES: cap }))
}

/** Wires a live configuration to a recorder the way the loop daemon does. */
function liveConfig(startupCap: number, owns: () => boolean = () => true): LoopConfig {
  setCap(startupCap)
  let recorder: CycleCapRecorder = { observe: () => {} }
  const config = loadConfig({}, {
    filePath: configFile,
    onEvent: (event) => lines.push(event.message),
    onRead: (setting, value) => {
      if (setting === 'MAX_SCAN_CYCLES' && typeof value === 'number') recorder.observe(value)
    },
  })
  writeFileSync(capFile, `${config.maxScanCycles}\n`)
  recorder = createCycleCapRecorder(capFile, {
    persisted: startupCap,
    label: 'queue/cycle-cap.txt',
    owns,
    warn: (detail) => lines.push(`WARN ${detail}`),
  })
  return config
}

/** A non-empty directory in the file's place makes every replacement of it fail. */
function blockCapFile(): void {
  rmSync(capFile, { force: true })
  mkdirSync(join(capFile, 'held'), { recursive: true })
}

function warnings(): string[] {
  return lines.filter((line) => line.startsWith('WARN '))
}

describe('cycle cap recorder', () => {
  it('persists a live cap change on the read that observes it', () => {
    const config = liveConfig(10)
    setCap(4)

    expect(config.maxScanCycles).toBe(4)

    expect(readFileSync(capFile, 'utf8')).toBe('4\n')
    expect(lines).toEqual(["MAX_SCAN_CYCLES changed from '10' to '4'"])
  })

  it('warns instead of throwing when a write fails, and persists the cap on the next read', () => {
    const config = liveConfig(10)
    blockCapFile()
    setCap(4)

    expect(() => config.maxScanCycles).not.toThrow()
    expect(lines[0]).toBe("MAX_SCAN_CYCLES changed from '10' to '4'")
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatch(/^WARN could not write queue\/cycle-cap\.txt: \S/)

    rmSync(capFile, { recursive: true, force: true })
    expect(config.maxScanCycles).toBe(4)

    expect(readFileSync(capFile, 'utf8')).toBe('4\n')
    expect(warnings()).toHaveLength(1)
    expect(lines.filter((line) => line.includes('changed from'))).toHaveLength(1)
  })

  it('warns once per change while the write keeps failing', () => {
    const config = liveConfig(10)
    blockCapFile()
    setCap(4)
    for (let read = 0; read < 5; read++) expect(config.maxScanCycles).toBe(4)
    expect(warnings()).toHaveLength(1)

    setCap(25)
    for (let read = 0; read < 5; read++) expect(config.maxScanCycles).toBe(25)

    expect(warnings()).toHaveLength(2)
    expect(lines.filter((line) => line.includes('changed from'))).toEqual([
      "MAX_SCAN_CYCLES changed from '10' to '4'",
      "MAX_SCAN_CYCLES changed from '4' to '25'",
    ])
  })

  it('leaves no temporary file behind after a write or a failed one', () => {
    const config = liveConfig(10)
    setCap(4)
    expect(config.maxScanCycles).toBe(4)
    expect(readdirSync(directory).sort()).toEqual(['config.json', 'cycle-cap.txt'])

    blockCapFile()
    setCap(25)
    expect(config.maxScanCycles).toBe(25)

    expect(warnings()).toHaveLength(1)
    expect(readdirSync(directory).sort()).toEqual(['config.json', 'cycle-cap.txt'])
  })

  it('stops writing once another daemon owns the file', () => {
    let owns = true
    const config = liveConfig(10, () => owns)
    owns = false
    setCap(4)

    expect(config.maxScanCycles).toBe(4)

    expect(readFileSync(capFile, 'utf8')).toBe('10\n')
    expect(warnings()).toEqual([])
  })
})
