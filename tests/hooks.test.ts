import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const hooksDirectory = resolve(import.meta.dirname, '..', '.githooks')
const temporaryDirectories: string[] = []

/**
 * The POSIX shell these hooks run under, as something this machine can spawn.
 *
 * Git Bash puts `sh` on PATH, but a PowerShell or cmd session carries only Git's launcher
 * directory, where a bare `sh` fails to spawn at all — and the loop's gate runs the suite
 * from cmd. Git for Windows ships the shell inside its own installation, so derive it from
 * the git this run can already invoke, and fall back to a bare `sh` on every host that
 * resolves one itself.
 *
 * Only `bin/sh.exe` qualifies. It is the launcher that gives the shell the POSIX PATH the
 * hooks' `grep` and `head` come from; `usr/bin/sh.exe` starts with the caller's Windows
 * PATH, and under it the hooks fail for want of those utilities rather than for what they
 * were asked to judge.
 */
function posixShell(): string {
  if (process.platform !== 'win32') return 'sh'
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true })
  if (execPath.status !== 0) return 'sh'
  // `--exec-path` points deep inside the installation (`mingw64/libexec/git-core`) while
  // the shell sits beside its root, so climb until a `bin/sh.exe` answers.
  for (let directory = resolve(execPath.stdout.trim()); ; directory = dirname(directory)) {
    const candidate = join(directory, 'bin', 'sh.exe')
    if (existsSync(candidate)) return candidate
    if (dirname(directory) === directory) return 'sh'
  }
}

const shell = posixShell()

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('git hooks', () => {
  it.each(['pre-commit', 'commit-msg'])('%s is valid POSIX sh syntax', (hook) => {
    const hookPath = join(hooksDirectory, hook)
    const source = readFileSync(hookPath, 'utf8')
    const result = spawnSync(shell, ['-n', hookPath], {
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(source.startsWith('#!/bin/sh\n')).toBe(true)
    expect(result.stderr).toBe('')
    expect(result.status, result.error?.message).toBe(0)
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

    const result = spawnSync(shell, [join(hooksDirectory, 'commit-msg'), messagePath], {
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status, result.error?.message).toBe(expectedStatus)
  })
})
