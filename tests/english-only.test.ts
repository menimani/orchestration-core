import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main, scanText } from '../checks/english-only.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('English-only source check', () => {
  it('accepts ASCII, English typography, and borrowed Latin letters', () => {
    expect(scanText('A cafe\u0301 is not the same spelling as cafe.')).toEqual([])
    expect(scanText('A caf\u00e9 menu \u2014 previous \u2190 next \u2192')).toEqual([])
  })

  it('reports non-English scripts, full-width punctuation, and invisible characters', () => {
    const violations = scanText([
      '\u65e5\u672c\u8a9e',
      '\u041a\u0438\u0440\u0438\u043b\u043b\u0438\u0446\u0430',
      'full-width\uff08text\uff09',
      'zero\u200bwidth',
      'unexpected \u00d7 symbol',
      'unexpected \ud83d\udca1\ufe0f emoji',
    ].join('\n'))

    expect(violations.map((violation) => violation.line)).toEqual([1, 2, 3, 4, 5, 6])
    expect(violations[0]?.codePoints).toEqual(['U+65E5', 'U+672C', 'U+8A9E'])
    expect(violations[2]?.codePoints).toEqual(['U+FF08', 'U+FF09'])
    expect(violations[3]?.codePoints).toEqual(['U+200B'])
    expect(violations[4]?.codePoints).toEqual(['U+00D7'])
    expect(violations[5]?.codePoints).toEqual(['U+1F4A1', 'U+FE0F'])
  })

  it('rejects non-English Latin letters and combining marks', () => {
    const violations = scanText('Ti\u1ebfng Vi\u1ec7t va\u0300 tie\u0302ng')

    expect(violations).toHaveLength(1)
    expect(violations[0]?.codePoints).toEqual([
      'U+1EBF', 'U+1EC7', 'U+0300', 'U+0302',
    ])
  })

  it('checks every repository source during the normal test suite', () => {
    expect(main()).toBe(0)
  })

  it('ignores retained dependency trees from safe npm cleanup failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-english-only-'))
    fixtures.push(root)
    writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
    for (const retained of [
      '.node_modules.previous-123-456',
      '.orchestration-npm-ci-abcdef',
    ]) {
      const dependency = join(root, retained, 'node_modules', 'fixture')
      mkdirSync(dependency, { recursive: true })
      writeFileSync(join(dependency, 'README.md'), 'dependency emoji \ud83d\udca1\n')
    }

    expect(main(root)).toBe(0)
  })

  it('checks retained dependency directory names below the package root', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-english-only-'))
    fixtures.push(root)
    for (const nested of [
      '.node_modules.previous-123-456',
      '.orchestration-npm-ci-abcdef',
    ]) {
      const source = join(root, 'src', nested)
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'fixture.ts'), 'export const greeting = "\u65e5\u672c\u8a9e"\n')
    }
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(main(root)).toBe(1)
    expect(output).toHaveBeenCalledWith('2 lines')
    output.mockRestore()
  })
})
