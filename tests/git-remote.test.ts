import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  currentBranchPushRemote, currentBranchRemotes, currentBranchTrackingRemote,
  currentRemoteDefaultBranch,
} from '../src/gitRemote.ts'

// Records the git processes started while a test asks for them.
const gitProcesses = vi.hoisted(() => ({ recording: false, argv: [] as string[][] }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    const [file, gitArgs] = args
    if (gitProcesses.recording && file === 'git' && Array.isArray(gitArgs)) {
      gitProcesses.argv.push([...gitArgs])
    }
    return actual.execFileSync(...args)
  }) as typeof actual.execFileSync
  return { ...actual, execFileSync }
})

let repoRoot: string

function recordedGit<T>(question: () => T): { answer: T, argv: string[][] } {
  gitProcesses.argv = []
  gitProcesses.recording = true
  try {
    return { answer: question(), argv: gitProcesses.argv }
  } finally {
    gitProcesses.recording = false
  }
}

function answerOrError(question: () => string): string {
  try {
    return question()
  } catch (error) {
    return `error: ${(error as Error).message}`
  }
}

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
  gitProcesses.recording = false
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

describe('current branch remote lookups', () => {
  const ambiguous = "current branch 'main' has no upstream and the repository has multiple remotes: "
    + 'origin, upstream; push the branch with an upstream, or configure branch.main.remote'

  // Each precedence level, with the push and tracking answers the documented rules give.
  const states: { name: string, arrange: () => void, push: string, tracking: string }[] = [
    {
      name: 'the branch push remote',
      arrange: () => {
        git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
        git(['config', 'branch.main.pushRemote', 'upstream'])
      },
      push: 'upstream',
      tracking: 'upstream',
    },
    {
      name: 'the default push remote',
      arrange: () => {
        git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
        git(['config', 'remote.pushDefault', 'upstream'])
      },
      push: 'upstream',
      tracking: 'upstream',
    },
    {
      name: 'the upstream remote',
      arrange: () => {
        git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
        git(['config', 'branch.main.remote', 'upstream'])
        git(['config', 'branch.main.merge', 'refs/heads/main'])
        git(['config', 'branch.main.pushRemote', 'origin'])
      },
      push: 'origin',
      tracking: 'upstream',
    },
    {
      name: 'the branch remote without a merge ref',
      arrange: () => {
        git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
        git(['config', 'branch.main.remote', 'upstream'])
      },
      push: 'upstream',
      tracking: 'upstream',
    },
    {
      name: 'the only remote',
      arrange: () => {},
      push: 'origin',
      tracking: 'origin',
    },
    {
      name: 'no remote',
      arrange: () => git(['remote', 'remove', 'origin']),
      push: 'error: repository has no configured remote',
      tracking: 'error: repository has no configured remote',
    },
    {
      name: 'several remotes with none configured',
      arrange: () => git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')]),
      push: `error: ${ambiguous}`,
      tracking: `error: ${ambiguous}`,
    },
  ]

  for (const state of states) {
    it(`answers ${state.name} as documented, separately and together`, () => {
      state.arrange()

      expect(answerOrError(() => currentBranchPushRemote(repoRoot))).toBe(state.push)
      expect(answerOrError(() => currentBranchTrackingRemote(repoRoot))).toBe(state.tracking)
      expect(answerOrError(() => currentBranchRemotes(repoRoot).push)).toBe(state.push)
      expect(answerOrError(() => currentBranchRemotes(repoRoot).tracking)).toBe(state.tracking)
      expect(answerOrError(() => currentBranchRemotes(repoRoot, 'main').push)).toBe(state.push)
      expect(answerOrError(() => currentBranchRemotes(repoRoot, 'main').tracking))
        .toBe(state.tracking)
    })
  }

  it('rejects a detached checkout with the same error from every question', () => {
    git(['checkout', '--quiet', '--detach'])

    const message = 'the current checkout is not on a branch'
    expect(() => currentBranchPushRemote(repoRoot)).toThrow(message)
    expect(() => currentBranchTrackingRemote(repoRoot)).toThrow(message)
    expect(() => currentBranchRemotes(repoRoot)).toThrow(message)
    expect(() => currentBranchRemotes(repoRoot, '')).toThrow(message)
  })

  it('stops looking up push candidates at the first one naming an existing remote', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
    git(['config', 'branch.main.pushRemote', 'upstream'])
    git(['config', 'remote.pushDefault', 'origin'])
    git(['config', 'branch.main.remote', 'origin'])
    git(['config', 'branch.main.merge', 'refs/heads/main'])

    const { answer, argv } = recordedGit(() => currentBranchPushRemote(repoRoot))

    expect(answer).toBe('upstream')
    expect(argv).toEqual([
      ['branch', '--show-current'],
      ['remote'],
      ['config', '--get', 'branch.main.pushRemote'],
    ])
  })

  it('stops looking up tracking candidates at the first one naming an existing remote', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
    git(['config', 'branch.main.remote', 'upstream'])
    git(['config', 'branch.main.merge', 'refs/heads/main'])
    git(['config', 'branch.main.pushRemote', 'origin'])

    const { answer, argv } = recordedGit(() => currentBranchTrackingRemote(repoRoot))

    expect(answer).toBe('upstream')
    expect(argv).toEqual([
      ['branch', '--show-current'],
      ['remote'],
      ['for-each-ref', '--format=%(upstream:remotename)', 'refs/heads/main'],
    ])
  })

  it('reads the branch, the remotes and each candidate once when both remotes are asked together', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
    git(['config', 'branch.main.remote', 'upstream'])
    git(['config', 'branch.main.merge', 'refs/heads/main'])
    git(['config', 'branch.main.pushRemote', 'origin'])

    const { answer, argv } = recordedGit(() => currentBranchRemotes(repoRoot))

    expect(answer).toEqual({ push: 'origin', tracking: 'upstream' })
    expect(argv).toEqual([
      ['branch', '--show-current'],
      ['remote'],
      ['config', '--get', 'branch.main.pushRemote'],
      ['for-each-ref', '--format=%(upstream:remotename)', 'refs/heads/main'],
    ])
  })

  it('does not read the branch when the caller passes it', () => {
    const { answer, argv } = recordedGit(() => currentBranchRemotes(repoRoot, 'main'))

    expect(answer).toEqual({ push: 'origin', tracking: 'origin' })
    expect(argv).not.toContainEqual(['branch', '--show-current'])
    expect(argv.filter((args) => args[0] === 'remote')).toEqual([['remote']])
  })

  it('sees a remote configured between two questions', () => {
    git(['remote', 'add', 'upstream', join(repoRoot, 'upstream.git')])
    expect(() => currentBranchRemotes(repoRoot)).toThrow(ambiguous)

    git(['config', 'remote.pushDefault', 'upstream'])

    expect(currentBranchRemotes(repoRoot)).toEqual({ push: 'upstream', tracking: 'upstream' })
  })
})
