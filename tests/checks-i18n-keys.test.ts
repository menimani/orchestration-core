import { describe, expect, it } from 'vitest'
import {
  compareI18nKeys,
  extractBackendMessageIds,
  extractMessageIdsFromCode,
  extractTranslationKeys,
} from '../../../checks/i18n-keys.ts'

describe('i18n key repository check', () => {
  it('extracts static keys from representative frontend source', () => {
    const source = `
      t('nav.home')
      t(\`event.saved\`)
      t(\`event.\${status}\`)
      const response = { messageId: 'error.eventNotFound' }
    `

    expect([...extractMessageIdsFromCode(source)]).toEqual([
      'nav.home',
      'event.saved',
      'error.eventNotFound',
    ])
  })

  it('extracts message ids from a representative backend bundle', () => {
    const source = [
      '# Error messages',
      'error.eventNotFound=Event not found',
      'validation.nameRequired=Name is required',
      'application.title=Shiora',
    ].join('\n')

    expect([...extractBackendMessageIds(source)]).toEqual([
      'error.eventNotFound',
      'validation.nameRequired',
    ])
  })

  it('extracts nested keys from a representative locale file', () => {
    const source = `
      export const en = {
        nav: {
          home: 'Home',
        },
        error: {
          eventNotFound: 'Event not found',
        },
      }
    `

    expect([...extractTranslationKeys(source)]).toEqual([
      'nav',
      'nav.home',
      'error',
      'error.eventNotFound',
    ])
  })

  it('detects missing and orphaned keys', () => {
    const expected = new Set(['nav.home', 'event.missing'])
    const actual = new Set(['nav.home', 'event.orphaned'])

    expect(compareI18nKeys(expected, actual)).toEqual({
      missing: ['event.missing'],
      orphaned: ['event.orphaned'],
    })
  })
})
