import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const hooksDirectory = resolve(import.meta.dirname, '..', '.githooks')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('git hooks', () => {
  it.each(['pre-commit', 'commit-msg'])('%s is valid POSIX sh syntax', (hook) => {
    const hookPath = join(hooksDirectory, hook)
    const source = readFileSync(hookPath, 'utf8')
    const result = spawnSync('sh', ['-n', hookPath], {
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(source.startsWith('#!/bin/sh\n')).toBe(true)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it.each([
    ['feat: add portable hooks', 0],
    ['Merge branch \'main\'', 0],
    ['feature: add portable hooks', 1],
    ['fix:  starts with two spaces', 1],
    ['docs:', 1],
  ])('validates commit subject %j', (subject, expectedStatus) => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-hook-'))
    temporaryDirectories.push(directory)
    const messagePath = join(directory, 'COMMIT_EDITMSG')
    writeFileSync(messagePath, `${subject}\nbody\n`)

    const result = spawnSync('sh', [join(hooksDirectory, 'commit-msg'), messagePath], {
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(expectedStatus)
  })
})
