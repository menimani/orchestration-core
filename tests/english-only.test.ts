import { describe, expect, it } from 'vitest'
import { scanText } from '../checks/english-only.ts'

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
    ].join('\n'))

    expect(violations.map((violation) => violation.line)).toEqual([1, 2, 3, 4, 5])
    expect(violations[0]?.codePoints).toEqual(['U+65E5', 'U+672C', 'U+8A9E'])
    expect(violations[2]?.codePoints).toEqual(['U+FF08', 'U+FF09'])
    expect(violations[3]?.codePoints).toEqual(['U+200B'])
    expect(violations[4]?.codePoints).toEqual(['U+00D7'])
  })
})
