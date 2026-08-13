import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  currentBranchPushRemote, currentBranchTrackingRemote, currentRemoteDefaultBranch,
} from '../src/gitRemote.ts'

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
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(join(repoRoot, 'README.md'), '# test\n')
  git(['add', 'README.md'])
  git(['commit', '-qm', 'chore: initial commit'])
  git(['remote', 'add', 'origin', join(repoRoot, 'origin.git')])
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('current branch remote', () => {
  it('uses the only repository remote when a fresh branch has no upstream', () => {
    expect(currentBranchPushRemote(repoRoot)).toBe('origin')
  })

  it('uses an explicit push default when multiple remotes exist', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
    git(['config', 'remote.pushDefault', 'upstream'])

    expect(currentBranchPushRemote(repoRoot)).toBe('upstream')
  })

  it('prefers the branch push remote over its tracking remote', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
    git(['config', 'branch.main.remote', 'upstream'])
    git(['config', 'branch.main.merge', 'refs/heads/main'])
    git(['config', 'branch.main.pushRemote', 'origin'])

    expect(currentBranchPushRemote(repoRoot)).toBe('origin')
    expect(currentBranchTrackingRemote(repoRoot)).toBe('upstream')
  })

  it('prefers the default push remote over the branch tracking remote', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
    git(['config', 'branch.main.remote', 'upstream'])
    git(['config', 'branch.main.merge', 'refs/heads/main'])
    git(['config', 'remote.pushDefault', 'origin'])

    expect(currentBranchPushRemote(repoRoot)).toBe('origin')
    expect(currentBranchTrackingRemote(repoRoot)).toBe('upstream')
  })

  it('rejects an ambiguous repository when no branch or push remote is configured', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])

    const message = "current branch 'main' has no upstream and the repository has multiple remotes: "
      + 'origin, upstream; push the branch with an upstream, or configure branch.main.remote'
    expect(() => currentBranchPushRemote(repoRoot)).toThrow(message)
    expect(() => currentBranchTrackingRemote(repoRoot)).toThrow(message)
  })

  it('reads the remote advertised default branch when no local HEAD ref is cached', () => {
    git(['init', '--bare', '--initial-branch=trunk', join(repoRoot, 'origin.git')])
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'])

    expect(currentRemoteDefaultBranch(repoRoot)).toEqual({ branch: 'trunk', remote: 'origin' })
  })

  it('ignores a stale cached remote HEAD after the advertised default changes', () => {
    git(['init', '--bare', '--initial-branch=main', join(repoRoot, 'origin.git')])
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'])

    expect(currentRemoteDefaultBranch(repoRoot)).toEqual({ branch: 'main', remote: 'origin' })
  })
})
