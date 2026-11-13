import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readConflictedAttempts, writeConflictedAttempts } from '../src/conflictRetry.ts'
import { readGateFixState, writeGateFixState } from '../src/gateFix.ts'
import { createOrchDirectories, orchPaths, type OrchPaths } from '../src/paths.ts'

const taskId = '20261113_120000_001_auto-conflict-record'
const attempt = {
  taskId: '20261113_110000_001_auto-conflict-record',
  branch: 'orch-conflict/20261113_110000_001_auto-conflict-record',
  runBranch: 'main',
  runTip: 'a'.repeat(40),
  base: 'b'.repeat(40),
  taskTip: 'c'.repeat(40),
  conflictedFiles: ['tracked.txt'],
  conflictingCommits: ['d'.repeat(40)],
}
let repoRoot: string
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-conflict-retry-'))
  paths = orchPaths(repoRoot)
  createOrchDirectories(paths)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('conflict retry records', () => {
  function writeRecord(content: string): string {
    const file = join(paths.queueDir, 'conflict-retry', `${taskId}.json`)
    mkdirSync(join(paths.queueDir, 'conflict-retry'), { recursive: true })
    writeFileSync(file, content)
    return file
  }

  it('reads back the attempts it wrote and nothing for a task without a record', () => {
    expect(readConflictedAttempts(paths, taskId)).toEqual([])

    writeConflictedAttempts(paths, taskId, [attempt])

    expect(readConflictedAttempts(paths, taskId)).toEqual([attempt])
  })

  it('rejects a record that is not valid JSON and keeps the parse error as its cause', () => {
    const file = writeRecord('[{"taskId": ')

    let thrown: unknown
    try {
      readConflictedAttempts(paths, taskId)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(`Malformed conflict retry record ${file}; repair or remove it`)
    expect((thrown as Error).cause).toBeInstanceOf(SyntaxError)
  })

  it.each([
    ['an empty array', '[]\n'],
    ['an object instead of an array', `${JSON.stringify(attempt)}\n`],
    ['an entry missing its branch', `${JSON.stringify([{ ...attempt, branch: undefined }])}\n`],
    ['an entry with an empty branch', `${JSON.stringify([{ ...attempt, branch: '' }])}\n`],
    ['a non-string conflicted file', `${JSON.stringify([{ ...attempt, conflictedFiles: [1] }])}\n`],
    ['a valid entry beside a null one', `${JSON.stringify([attempt, null])}\n`],
  ])('rejects a record holding %s', (_label, content) => {
    const file = writeRecord(content)

    expect(() => readConflictedAttempts(paths, taskId)).toThrow(
      new Error(`Malformed conflict retry record ${file}; repair or remove it`),
    )
  })
})

describe('gate fix records', () => {
  function writeRecord(content: string): string {
    const file = join(paths.queueDir, 'gate-fix', `${taskId}.json`)
    mkdirSync(join(paths.queueDir, 'gate-fix'), { recursive: true })
    writeFileSync(file, content)
    return file
  }

  it('reads back the state it wrote and nothing for a task without a record', () => {
    expect(readGateFixState(paths, taskId)).toBeUndefined()
    const state = { attempts: 1, verificationFailed: true, pending: false }

    writeGateFixState(paths, taskId, state)

    expect(readGateFixState(paths, taskId)).toEqual(state)
  })

  it('rejects a record that is not valid JSON and keeps the parse error as its cause', () => {
    const file = writeRecord('{"attempts": ')

    let thrown: unknown
    try {
      readGateFixState(paths, taskId)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(`Malformed gate fix record ${file}; repair or remove it`)
    expect((thrown as Error).cause).toBeInstanceOf(SyntaxError)
  })

  it.each([
    ['an array', '[]\n'],
    ['a negative attempt count', '{"attempts":-1,"verificationFailed":false,"pending":false}\n'],
    ['a fractional attempt count', '{"attempts":0.5,"verificationFailed":false,"pending":false}\n'],
    ['a missing pending flag', '{"attempts":0,"verificationFailed":false}\n'],
    ['a string verification flag', '{"attempts":0,"verificationFailed":"yes","pending":false}\n'],
  ])('rejects a record holding %s', (_label, content) => {
    const file = writeRecord(content)

    expect(() => readGateFixState(paths, taskId)).toThrow(
      new Error(`Malformed gate fix record ${file}; repair or remove it`),
    )
  })
})
