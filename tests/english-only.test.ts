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
  const characters = (...codePoints: number[]): string => String.fromCodePoint(...codePoints)

  it('accepts ASCII, English typography, and borrowed Latin letters', () => {
    expect(scanText(`A cafe${characters(0x301)} is not the same spelling as cafe.`)).toEqual([])
    expect(scanText(`A caf${characters(0xe9)} menu — previous ← next →`)).toEqual([])
  })

  it('reports non-English scripts, full-width punctuation, and invisible characters', () => {
    const violations = scanText([
      characters(0x65e5, 0x672c, 0x8a9e),
      characters(0x41a, 0x438, 0x440, 0x438, 0x43b, 0x43b, 0x438, 0x446, 0x430),
      `full-width${characters(0xff08)}text${characters(0xff09)}`,
      `zero${characters(0x200b)}width`,
      `unexpected ${characters(0xd7)} symbol`,
      `unexpected ${characters(0x1f4a1, 0xfe0f)} emoji`,
    ].join('\n'))

    expect(violations.map((violation) => violation.line)).toEqual([1, 2, 3, 4, 5, 6])
    expect(violations[0]?.codePoints).toEqual(['U+65E5', 'U+672C', 'U+8A9E'])
    expect(violations[2]?.codePoints).toEqual(['U+FF08', 'U+FF09'])
    expect(violations[3]?.codePoints).toEqual(['U+200B'])
    expect(violations[4]?.codePoints).toEqual(['U+00D7'])
    expect(violations[5]?.codePoints).toEqual(['U+1F4A1', 'U+FE0F'])
  })

  it('rejects non-English Latin letters and combining marks', () => {
    const violations = scanText(`Ti${characters(0x1ebf)}ng Vi${characters(0x1ec7)}t va${characters(0x300)} tie${characters(0x302)}ng`)

    expect(violations).toHaveLength(1)
    expect(violations[0]?.codePoints).toEqual([
      'U+1EBF', 'U+1EC7', 'U+0300', 'U+0302',
    ])
  })

  it('reports non-English code points hidden in source escapes', () => {
    const slash = characters(92)
    const violations = scanText([
      `${slash}u65e5${slash}u672c${slash}u8a9e`,
      `${slash}u{1f4a1}${slash}ufe0f`,
      `${slash}xD7`,
    ].join('\n'))

    expect(violations.map((violation) => violation.codePoints)).toEqual([
      ['U+65E5', 'U+672C', 'U+8A9E'],
      ['U+1F4A1', 'U+FE0F'],
      ['U+00D7'],
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
      writeFileSync(join(dependency, 'README.md'), `dependency emoji ${characters(0x1f4a1)}\n`)
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
      writeFileSync(join(source, 'fixture.ts'), `export const greeting = "${characters(0x65e5, 0x672c, 0x8a9e)}"\n`)
    }
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(main(root)).toBe(1)
    expect(output).toHaveBeenCalledWith('2 lines')
    output.mockRestore()
  })
})
