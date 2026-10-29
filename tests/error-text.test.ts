import { describe, expect, it } from 'vitest'
import { commandFailureSummary, errorHeadline } from '../src/errorText.ts'

describe('commandFailureSummary', () => {
  it('prefers a failed command stderr over the thrown message', () => {
    const error = Object.assign(new Error('Command failed: git merge'), {
      stderr: 'error: could not apply 1a2b3c',
    })
    expect(commandFailureSummary(error)).toBe('error: could not apply 1a2b3c')
  })

  it('decodes a stderr captured as a buffer', () => {
    const error = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from('fatal: not a git repository\n', 'utf8'),
    })
    expect(commandFailureSummary(error)).toBe('fatal: not a git repository')
  })

  it('collapses the newlines of a multi-line stderr into one log line', () => {
    const error = Object.assign(new Error('Command failed'), {
      stderr: 'CONFLICT (content): Merge conflict in src/loop.ts\r\nAutomatic merge failed\n',
    })
    expect(commandFailureSummary(error)).toBe(
      'CONFLICT (content): Merge conflict in src/loop.ts Automatic merge failed',
    )
  })

  it('falls back to the message when stderr is absent or blank', () => {
    expect(commandFailureSummary(new Error('spawn git ENOENT'))).toBe('spawn git ENOENT')
    const blank = Object.assign(new Error('exited with code 128'), { stderr: '   \n' })
    expect(commandFailureSummary(blank)).toBe('exited with code 128')
  })

  it('reports a value thrown as something other than an error', () => {
    expect(commandFailureSummary('git exploded')).toBe('git exploded')
  })
})

describe('errorHeadline', () => {
  it('keeps the first line, which is the part that names the failure', () => {
    const error = new Error('port 3000 is already in use\n    at listen (net.js:1)')
    expect(errorHeadline(error)).toBe('port 3000 is already in use')
  })

  it('splits on a carriage return as well as a newline', () => {
    expect(errorHeadline(new Error('daemon refused to start\r\ncaused by: EACCES')))
      .toBe('daemon refused to start')
  })

  it('reports a value thrown as something other than an error', () => {
    expect(errorHeadline(42)).toBe('42')
  })

  it('still says something when the error carries no message', () => {
    expect(errorHeadline(new Error(''))).toBe('unknown error')
    expect(errorHeadline(new Error('   \n   '))).toBe('unknown error')
  })
})
