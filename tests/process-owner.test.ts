import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  processIsAlive: vi.fn(),
  processStartIdentity: vi.fn(),
}))

vi.mock('../src/adapters/os.ts', () => ({
  operatingSystem: {
    processIsAlive: mocks.processIsAlive,
    processStartIdentity: mocks.processStartIdentity,
  },
}))

import {
  currentProcessStartIdentity,
  decodeProcessStartIdentity,
  encodeProcessStartIdentity,
  lockOwnerIsCurrent,
} from '../src/processOwner.ts'

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe('currentProcessStartIdentity', () => {
  it('returns the identity of the current process ID', () => {
    mocks.processStartIdentity.mockReturnValue('started-at-1')

    expect(currentProcessStartIdentity()).toBe('started-at-1')
    expect(mocks.processStartIdentity).toHaveBeenCalledWith(process.pid)
  })

  it('records null when the identity is unavailable', () => {
    mocks.processStartIdentity.mockReturnValue(undefined)

    expect(currentProcessStartIdentity()).toBeNull()
  })

  it('records null, written as "-", when capturing the identity throws', () => {
    mocks.processStartIdentity.mockImplementation(() => {
      throw new Error('lookup failed')
    })

    const identity = currentProcessStartIdentity()

    expect(identity).toBeNull()
    expect(encodeProcessStartIdentity(identity)).toBe('-')
  })
})

describe('encodeProcessStartIdentity and decodeProcessStartIdentity', () => {
  it('encodes an identity as base64url', () => {
    expect(encodeProcessStartIdentity('2026-11-14 16:28:30')).toBe('MjAyNi0xMS0xNCAxNjoyODozMA')
  })

  it.each(['2026-11-14 16:28:30', 'x', 'identity with spaces\tand tabs', 'pid=4321;start=~?>'])(
    'decodes the encoding of %j back to the original',
    (identity) => {
      expect(decodeProcessStartIdentity(encodeProcessStartIdentity(identity))).toBe(identity)
    },
  )

  it.each([
    ['missing metadata', undefined],
    ['the null-identity marker', '-'],
    ['an empty value', ''],
    ['padding characters', 'eA=='],
    ['standard base64 characters', 'a+b/'],
    ['whitespace', 'eA eA'],
    ['non-canonical base64url', 'eB'],
    ['a value that decodes to nothing', 'A'],
  ])('treats %s as unverifiable', (_label, encoded) => {
    expect(decodeProcessStartIdentity(encoded)).toBeUndefined()
  })
})

describe('lockOwnerIsCurrent', () => {
  it('is current when the live identity matches the recorded one', () => {
    mocks.processStartIdentity.mockReturnValue('started-at-1')
    mocks.processIsAlive.mockReturnValue(true)

    expect(lockOwnerIsCurrent(4321, 'started-at-1')).toBe(true)
    expect(mocks.processStartIdentity).toHaveBeenCalledWith(4321)
    expect(mocks.processIsAlive).not.toHaveBeenCalled()
  })

  it('is not current when a live process reuses the PID with a different identity', () => {
    mocks.processStartIdentity.mockReturnValue('started-at-2')
    mocks.processIsAlive.mockReturnValue(true)

    expect(lockOwnerIsCurrent(4321, 'started-at-1')).toBe(false)
    expect(mocks.processIsAlive).not.toHaveBeenCalled()
  })

  it.each([true, false])('falls back to processIsAlive (%s) when the identity lookup throws', (alive) => {
    mocks.processStartIdentity.mockImplementation(() => {
      throw new Error('lookup failed')
    })
    mocks.processIsAlive.mockReturnValue(alive)

    expect(lockOwnerIsCurrent(4321, 'started-at-1')).toBe(alive)
    expect(mocks.processStartIdentity).toHaveBeenCalledWith(4321)
    expect(mocks.processIsAlive).toHaveBeenCalledWith(4321)
  })

  it.each([true, false])('falls back to processIsAlive (%s) when the live identity is unavailable', (alive) => {
    mocks.processStartIdentity.mockReturnValue(undefined)
    mocks.processIsAlive.mockReturnValue(alive)

    expect(lockOwnerIsCurrent(4321, 'started-at-1')).toBe(alive)
    expect(mocks.processIsAlive).toHaveBeenCalledWith(4321)
  })

  it.each([
    ['legacy metadata without an identity', undefined],
    ['an identity recorded as unavailable', null],
  ])('uses processIsAlive alone for %s', (_label, startIdentity) => {
    mocks.processIsAlive.mockReturnValue(true)

    expect(lockOwnerIsCurrent(4321, startIdentity)).toBe(true)
    expect(mocks.processIsAlive).toHaveBeenCalledWith(4321)
    expect(mocks.processStartIdentity).not.toHaveBeenCalled()
  })
})
