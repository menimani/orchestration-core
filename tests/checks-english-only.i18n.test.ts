import { describe, expect, it } from 'vitest'
import { isJapaneseAllowedPath, scanText } from '../../../checks/english-only.ts'

const japaneseText = '日本語'

const violationsForFile = (file: string, content: string) =>
  isJapaneseAllowedPath(file) ? [] : scanText(content)

describe('English-only repository check', () => {
  it('allows Japanese in translation and i18n assertion files', () => {
    expect(violationsForFile('src/frontend/src/i18n/translations/ja.ts', japaneseText)).toEqual([])
    expect(violationsForFile('src/frontend/tests/language.i18n.test.ts', japaneseText)).toEqual([])
  })

  it('reports the violating lines in ordinary source files', () => {
    expect(violationsForFile('src/frontend/src/Page.tsx', `English\n${japaneseText}`)).toEqual([{
      line: 2,
      codePoints: ['U+65E5', 'U+672C', 'U+8A9E'],
      text: japaneseText,
    }])
  })

  it('excludes generated output', () => {
    expect(violationsForFile('src/frontend/coverage/report.html', japaneseText)).toEqual([])
  })
})
