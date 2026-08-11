import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentBranchRemote } from '../src/gitRemote.ts'

let repoRoot: string

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-git-remote-'))
  git(['init', '--initial-branch=main'])
  git(['remote', 'add', 'origin', join(repoRoot, 'origin.git')])
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('current branch remote', () => {
  it('uses the only repository remote when a fresh branch has no upstream', () => {
    expect(currentBranchRemote(repoRoot)).toBe('origin')
  })

  it('uses an explicit push default when multiple remotes exist', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
    git(['config', 'remote.pushDefault', 'upstream'])

    expect(currentBranchRemote(repoRoot)).toBe('upstream')
  })

  it('rejects an ambiguous repository when no branch or push remote is configured', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])

    expect(() => currentBranchRemote(repoRoot)).toThrow('repository has multiple remotes')
  })
})
