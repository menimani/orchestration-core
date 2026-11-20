import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function gitRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orch-git-isolation-'))
  fixtures.push(directory)
  execFileSync('git', ['init', '-q', directory], { stdio: 'ignore' })
  return directory
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('the isolated git configuration', () => {
  it('gives every git process the write-speed settings through the global file', () => {
    const repository = gitRepository()

    expect(git(repository, ['config', '--global', '--get', 'core.fsync'])).toBe('none')
    expect(git(repository, ['config', '--global', '--get', 'gc.auto'])).toBe('0')
    expect(git(repository, ['config', '--global', '--get', 'maintenance.auto'])).toBe('false')
  })

  it('still keeps the system configuration out', () => {
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1')
  })

  it('lets a value set in a fixture repository override the global file', () => {
    const repository = gitRepository()
    git(repository, ['config', 'core.fsync', 'all'])
    git(repository, ['config', 'gc.auto', '6700'])
    git(repository, ['config', 'maintenance.auto', 'true'])

    expect(git(repository, ['config', '--get', 'core.fsync'])).toBe('all')
    expect(git(repository, ['config', '--get', 'gc.auto'])).toBe('6700')
    expect(git(repository, ['config', '--get', 'maintenance.auto'])).toBe('true')
    expect(git(repository, ['config', '--global', '--get', 'core.fsync'])).toBe('none')
  })
})
