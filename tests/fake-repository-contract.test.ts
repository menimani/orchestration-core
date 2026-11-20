import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitRunner } from '../src/gitRunner.ts'
import { FakeRepository, type FakeRepositoryState } from './fakeRepository.ts'

// The fake repository stands in for git in the loop tests, so its answers are only worth
// what this file proves: every state it distinguishes is built in a real repository, and
// every invocation it answers is asked of real git and of the fake, which must agree on
// the output, or on the failure status. This file runs real git on purpose.

const realGit: GitRunner = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  // A directory outside every repository must not find one above the temporary root.
  env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
})

type Outcome = { output: string } | { status: number | null }

function outcome(run: GitRunner, cwd: string, args: string[]): Outcome {
  try {
    return { output: run(cwd, args) }
  } catch (error) {
    return { status: (error as { status?: number | null }).status ?? null }
  }
}

interface ContractState {
  name: string
  /** Builds the state in `root` and returns how the fake describes it. */
  build: (root: string) => Partial<FakeRepositoryState>
  /** Invocations only this state can answer, asked in addition to the common ones. */
  extra?: string[][]
}

function setup(root: string, ...args: string[]): string {
  return realGit(root, args).trim()
}

function commit(root: string, content: string): void {
  writeFileSync(join(root, 'tracked.txt'), content)
  setup(root, 'add', 'tracked.txt')
  setup(root, 'commit', '-q', '-m', content.trim())
}

/** initializeGitRepo's state: main, one commit, no remote, clean. */
function initialRepository(root: string): Partial<FakeRepositoryState> {
  setup(root, 'init', '-q', '--initial-branch=main')
  setup(root, 'config', 'user.email', 'contract@example.test')
  setup(root, 'config', 'user.name', 'Contract Test')
  commit(root, 'initial\n')
  return { head: setup(root, 'rev-parse', 'HEAD') }
}

/** A task worktree on its own branch at HEAD, beside the work tree like a remote. */
function taskWorktree(root: string, state: Partial<FakeRepositoryState>): Partial<FakeRepositoryState> {
  const path = `${root}-task`
  setup(root, 'worktree', 'add', '-q', path, '-b', 'task/one')
  writeFileSync(join(path, 'work.txt'), 'untracked\n')
  return { ...state, branches: ['main', 'task/one'], worktrees: [{ path, branch: 'task/one' }] }
}

/** initializeGitRepoWithRemote's state: main pushed to origin, whose HEAD names main. */
function pushedToOrigin(root: string, state: Partial<FakeRepositoryState>): Partial<FakeRepositoryState> {
  const url = bareRemote(root, 'origin')
  setup(root, 'push', '-q', '-u', 'origin', 'main')
  realGit(url, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  setup(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  return {
    ...state,
    remotes: [{ name: 'origin', url, defaultBranch: 'main' }],
    upstreams: { main: 'origin' },
    commitsAhead: { 'origin/main': 0 },
  }
}

// Beside the work tree rather than in it, where it would be an untracked directory.
function bareRemote(root: string, name: string): string {
  const remote = `${root}-${name}.git`
  execFileSync('git', ['init', '-q', '--bare', remote], { windowsHide: true })
  setup(root, 'remote', 'add', name, remote)
  return remote
}

// A bare remote's HEAD otherwise names whatever init.defaultBranch the host configures.
function remoteHead(remote: string, branch: string): void {
  execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: remote, windowsHide: true })
}

const STATES: ContractState[] = [
  { name: 'a fresh repository on main', build: initialRepository },
  {
    name: 'a detached HEAD',
    build: (root) => {
      const state = initialRepository(root)
      setup(root, 'checkout', '-q', '--detach')
      return { ...state, branch: undefined, branches: ['main'] }
    },
    extra: [['worktree', 'list', '--porcelain', '-z']],
  },
  {
    name: 'a branch pushed with an upstream to a remote with a default branch',
    build: (root) => {
      const state = initialRepository(root)
      const url = bareRemote(root, 'origin')
      setup(root, 'push', '-q', '-u', 'origin', 'main')
      setup(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
      return {
        ...state,
        remotes: [{ name: 'origin', url, defaultBranch: 'main' }],
        upstreams: { main: 'origin' },
      }
    },
  },
  {
    name: 'a remote whose own HEAD names the branch pushed to it',
    build: (root) => {
      const state = initialRepository(root)
      const url = bareRemote(root, 'origin')
      setup(root, 'push', '-q', '-u', 'origin', 'main')
      remoteHead(url, 'main')
      setup(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
      const commits = { main: setup(root, 'rev-parse', 'HEAD') }
      return {
        ...state,
        remotes: [{
          name: 'origin', url, defaultBranch: 'main', head: 'main',
          branches: commits, trackingBranches: { ...commits },
        }],
        upstreams: { main: 'origin' },
      }
    },
    extra: [
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['rev-parse', '--verify', 'origin/main^{commit}'],
      ['rev-parse', '--verify', 'origin/absent^{commit}'],
      ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['fetch', '--quiet', 'origin', '+refs/heads/absent:refs/remotes/origin/absent'],
    ],
  },
  {
    name: 'a remote whose own HEAD names a branch it lacks',
    build: (root) => {
      const state = initialRepository(root)
      const url = bareRemote(root, 'origin')
      setup(root, 'push', '-q', '-u', 'origin', 'main')
      remoteHead(url, 'missing')
      const commits = { main: setup(root, 'rev-parse', 'HEAD') }
      return {
        ...state,
        remotes: [{
          name: 'origin', url, head: 'missing', branches: commits, trackingBranches: { ...commits },
        }],
        upstreams: { main: 'origin' },
      }
    },
    extra: [['ls-remote', '--symref', 'origin', 'HEAD']],
  },
  {
    name: 'a stale remote-tracking branch locked by a crashed git process',
    build: (root) => {
      initialRepository(root)
      const url = bareRemote(root, 'origin')
      setup(root, 'push', '-q', '-u', 'origin', 'main')
      remoteHead(url, 'main')
      const stale = setup(root, 'rev-parse', 'HEAD')
      commit(root, 'advanced\n')
      const advanced = setup(root, 'rev-parse', 'HEAD')
      setup(root, 'push', '-q', 'origin', 'main')
      setup(root, 'update-ref', 'refs/remotes/origin/main', stale)
      writeFileSync(join(root, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '')
      return {
        head: advanced,
        remotes: [{
          name: 'origin', url, head: 'main',
          branches: { main: advanced }, trackingBranches: { main: stale },
        }],
        upstreams: { main: 'origin' },
        lockedRefs: ['refs/remotes/origin/main'],
      }
    },
    extra: [
      ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['rev-parse', '--verify', 'origin/main^{commit}'],
    ],
  },
  {
    name: 'two remotes with a configured push remote and push default',
    build: (root) => {
      const state = initialRepository(root)
      const fork = bareRemote(root, 'fork')
      const origin = bareRemote(root, 'origin')
      setup(root, 'config', 'branch.main.pushRemote', 'fork')
      setup(root, 'config', 'remote.pushDefault', 'origin')
      return {
        ...state,
        remotes: [{ name: 'fork', url: fork }, { name: 'origin', url: origin }],
        pushRemotes: { main: 'fork' },
        pushDefault: 'origin',
      }
    },
  },
  {
    name: 'a tracked file changed in the working tree',
    build: (root) => {
      const state = initialRepository(root)
      writeFileSync(join(root, 'tracked.txt'), 'changed\n')
      return { ...state, modifiedFiles: ['tracked.txt'] }
    },
  },
  {
    name: 'two commits ahead of a base branch',
    build: (root) => {
      initialRepository(root)
      setup(root, 'branch', 'base')
      commit(root, 'second\n')
      commit(root, 'third\n')
      return {
        head: setup(root, 'rev-parse', 'HEAD'),
        branches: ['main', 'base'],
        commitsAhead: { base: 2 },
      }
    },
    extra: [['rev-list', '--count', 'base..HEAD']],
  },
  {
    name: 'main pushed to the default branch of origin',
    build: (root) => pushedToOrigin(root, initialRepository(root)),
    extra: [
      ['fetch', 'origin', 'main', '--quiet'],
      ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['rev-parse', '--verify', 'origin/main^{commit}'],
      ['log', 'origin/main..HEAD', '--no-merges', '--pretty=%H|%s'],
      ['rev-list', '--count', 'origin/main..HEAD'],
    ],
  },
  {
    name: 'a task worktree on its own branch',
    build: (root) => taskWorktree(root, initialRepository(root)),
    extra: [
      ['worktree', 'list', '--porcelain', '-z'],
      ['for-each-ref', '--format=%(refname)', 'refs/heads'],
    ],
  },
  {
    name: 'a directory outside every repository',
    build: () => ({ repository: false }),
  },
]

// Every invocation the fake answers, with the names the states above make present and absent.
const COMMON_INVOCATIONS: string[][] = [
  ['branch', '--show-current'],
  ['rev-parse', 'HEAD'],
  ['remote'],
  ['status', '--porcelain'],
  ['config', '--get', 'remote.pushDefault'],
  ['config', '--get', 'branch.main.pushRemote'],
  ['config', '--get', 'branch.main.remote'],
  ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
  ['for-each-ref', '--format=%(upstream:remotename)', 'refs/heads/main'],
  ['for-each-ref', '--format=%(upstream:remotename)', 'refs/heads/absent'],
  ['show-ref', '--verify', '--quiet', 'refs/heads/main'],
  ['show-ref', '--verify', '--quiet', 'refs/heads/absent'],
  ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
  ['remote', 'get-url', 'origin'],
  ['remote', 'get-url', 'absent'],
]

let workspace: string

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'orch-fake-repository-'))
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('the fake repository against real git', () => {
  STATES.forEach((state, index) => {
    describe(state.name, () => {
      let root: string
      let fake: FakeRepository

      beforeAll(() => {
        root = join(workspace, String(index))
        mkdirSync(root)
        fake = new FakeRepository(root, state.build(root))
      })

      it.each([...COMMON_INVOCATIONS, ...(state.extra ?? [])].map((args) => [args.join(' '), args]))(
        'answers git %s as git does',
        (_invocation, args) => {
          expect(outcome(fake.git, root, args)).toEqual(outcome(realGit, root, args))
          expect(fake.unanswered).toEqual([])
        },
      )
    })
  })
})

// cleanupTask removes a task's worktree and branch and then checks that git forgot both.
// Each step changes the repository, so real git runs the whole sequence first and the
// fake runs it after the worktree directory is put back; every answer and every
// effect on disk must agree.
describe('the fake repository against real git, removing a task worktree', () => {
  it('removes the worktree and forgets the branch as git does', () => {
    const root = join(workspace, 'removal')
    mkdirSync(root)
    const state = taskWorktree(root, initialRepository(root))
    const worktree = state.worktrees?.[0]?.path ?? ''
    const steps: string[][] = [
      ['branch', '-D', 'task/one'],
      ['worktree', 'remove', worktree, '--force'],
      ['worktree', 'prune', '--expire', 'now'],
      ['worktree', 'list', '--porcelain', '-z'],
      ['branch', '-D', 'task/one'],
      ['for-each-ref', '--format=%(refname)', 'refs/heads'],
      ['branch', '-D', 'task/one'],
      ['worktree', 'remove', worktree, '--force'],
    ]
    const run = (git: GitRunner) => steps.map((args) => ({
      args: args.join(' '), outcome: outcome(git, root, args), worktreePresent: existsSync(worktree),
    }))

    const real = run(realGit)
    mkdirSync(worktree)
    writeFileSync(join(worktree, 'work.txt'), 'untracked\n')
    const fake = new FakeRepository(root, state)

    expect(run(fake.git)).toEqual(real)
    expect(fake.unanswered).toEqual([])
  })
})

// The loop pushes the run branch before it promotes it. Real git pushes first, and the
// fake, which changes nothing on disk, then answers the same steps.
describe('the fake repository against real git, pushing the run branch', () => {
  it('pushes the branch and catches its remote-tracking ref up as git does', () => {
    const root = join(workspace, 'push')
    mkdirSync(root)
    const pushed = pushedToOrigin(root, initialRepository(root))
    commit(root, 'ahead\n')
    const state = { ...pushed, head: setup(root, 'rev-parse', 'HEAD'), commitsAhead: { 'origin/main': 1 } }
    const steps: string[][] = [
      ['rev-list', '--count', 'origin/main..HEAD'],
      ['push', '--quiet', 'absent', 'main'],
      ['push', '--quiet', 'origin', 'absent'],
      ['push', '--quiet', 'origin', 'main'],
      ['rev-list', '--count', 'origin/main..HEAD'],
      ['rev-parse', '--verify', 'origin/main^{commit}'],
    ]
    const run = (git: GitRunner) => steps.map((args) => ({
      args: args.join(' '), outcome: outcome(git, root, args),
    }))

    const real = run(realGit)
    const fake = new FakeRepository(root, state)

    expect(run(fake.git)).toEqual(real)
    expect(fake.unanswered).toEqual([])
  })
})

// A topic branch that tracks origin/main and holds one commit beyond it: the questions
// a draft PR asks about its commits, and the comparison of a merged PR head with HEAD.
// Real git pushes the branch first, and the fake then answers the same steps.
describe('the fake repository against real git, opening a PR for a topic branch', () => {
  it('describes the commits beyond the base and pushes the branch as git does', () => {
    const root = join(workspace, 'topic')
    mkdirSync(root)
    const pushed = pushedToOrigin(root, initialRepository(root))
    const base = pushed.head ?? ''
    setup(root, 'switch', '-q', '-c', 'topic')
    setup(root, 'branch', '-q', '--set-upstream-to', 'origin/main')
    writeFileSync(join(root, 'feature.txt'), 'feature\n')
    setup(root, 'add', 'feature.txt')
    setup(root, 'commit', '-q', '-m', 'feat: a topic')
    const head = setup(root, 'rev-parse', 'HEAD')
    const state: Partial<FakeRepositoryState> = {
      ...pushed,
      branch: 'topic',
      branches: ['main', 'topic'],
      head,
      upstreams: { main: 'origin', topic: 'origin' },
      upstreamBranches: { topic: 'main' },
      commitsAhead: { 'origin/main': 1 },
      commits: { 'origin/main': [{ sha: head, subject: 'feat: a topic', files: ['feature.txt'] }] },
      ancestors: [base],
    }
    const unknown = 'f'.repeat(40)
    const steps: string[][] = [
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      ['config', '--get', 'branch.topic.remote'],
      ['for-each-ref', '--format=%(upstream:remotename)', 'refs/heads/topic'],
      ['rev-list', '--count', 'origin/main..HEAD'],
      ['log', 'origin/main..HEAD', '--no-merges', '--pretty=%H|%s'],
      ['log', 'origin/main..HEAD', '--merges', '--first-parent', '--reverse', '--format=%s%x1f%b%x1e'],
      ['show', '--name-only', '--pretty=format:', head],
      ['diff', '--name-only', 'origin/main..HEAD'],
      ['diff', '--name-only', '--diff-filter=D', 'origin/main..HEAD'],
      ['merge-base', '--is-ancestor', head, head],
      ['merge-base', '--is-ancestor', head, base],
      ['merge-base', '--is-ancestor', head, unknown],
      ['fetch', '--quiet', 'origin', unknown],
      ['push', '--quiet', 'origin', 'topic'],
      ['log', 'origin/topic..HEAD', '--no-merges', '--pretty=%H|%s'],
      ['log', 'origin/topic..HEAD', '--merges', '--first-parent', '--reverse', '--format=%s%x1f%b%x1e'],
      ['diff', '--name-only', 'origin/topic..HEAD'],
    ]
    const run = (git: GitRunner) => steps.map((args) => ({
      args: args.join(' '), outcome: outcome(git, root, args),
    }))

    const real = run(realGit)
    const fake = new FakeRepository(root, state)

    expect(run(fake.git)).toEqual(real)
    expect(fake.unanswered).toEqual([])
  })

  it('records the upstream a first push sets as git does', () => {
    const root = join(workspace, 'first-push')
    mkdirSync(root)
    const pushed = pushedToOrigin(root, initialRepository(root))
    setup(root, 'switch', '-q', '-c', 'topic')
    const state = { ...pushed, branch: 'topic', branches: ['main', 'topic'] }
    const steps: string[][] = [
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      ['push', '--quiet', '--set-upstream', 'origin', 'topic'],
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      ['config', '--get', 'branch.topic.remote'],
      ['rev-list', '--count', 'origin/topic..HEAD'],
    ]
    const run = (git: GitRunner) => steps.map((args) => ({
      args: args.join(' '), outcome: outcome(git, root, args),
    }))

    const real = run(realGit)
    const fake = new FakeRepository(root, state)

    expect(run(fake.git)).toEqual(real)
    expect(fake.unanswered).toEqual([])
  })
})

// A remote whose URL names no repository fails every fetch and push through it; a push
// URL that names one still pushes. Real git runs the steps first, then the fake.
describe('the fake repository against real git, reaching a missing repository', () => {
  it('fails to fetch and push through the missing URL as git does', () => {
    const root = join(workspace, 'missing')
    mkdirSync(root)
    const pushed = pushedToOrigin(root, initialRepository(root))
    const missing = `${root}-missing.git`
    const origin = { ...pushed.remotes?.[0], name: 'origin', url: missing }
    setup(root, 'remote', 'set-url', 'origin', missing)
    const state = { ...pushed, remotes: [origin], missingRepositories: [missing] }
    const steps: string[][] = [
      ['remote', 'get-url', 'origin'],
      ['fetch', 'origin', 'main', '--quiet'],
      ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['push', '--quiet', 'origin', 'main'],
      ['push', '--quiet', '--set-upstream', 'origin', 'main'],
    ]
    const run = (git: GitRunner) => steps.map((args) => ({
      args: args.join(' '), outcome: outcome(git, root, args),
    }))

    const real = run(realGit)
    const fake = new FakeRepository(root, state)

    expect(run(fake.git)).toEqual(real)
    expect(fake.unanswered).toEqual([])
  })

  it('pushes through a push URL while the fetch URL is missing as git does', () => {
    const root = join(workspace, 'push-url')
    mkdirSync(root)
    const pushed = pushedToOrigin(root, initialRepository(root))
    const pushUrl = pushed.remotes?.[0]?.url ?? ''
    const missing = `${root}-missing.git`
    setup(root, 'remote', 'set-url', '--push', 'origin', pushUrl)
    setup(root, 'remote', 'set-url', 'origin', missing)
    const origin = { name: 'origin', url: missing, pushUrl, defaultBranch: 'main' }
    const state = { ...pushed, remotes: [origin], missingRepositories: [missing] }
    const steps: string[][] = [
      ['remote', 'get-url', 'origin'],
      ['fetch', 'origin', 'main', '--quiet'],
      ['push', '--quiet', 'origin', 'main'],
    ]
    const run = (git: GitRunner) => steps.map((args) => ({
      args: args.join(' '), outcome: outcome(git, root, args),
    }))

    const real = run(realGit)
    const fake = new FakeRepository(root, state)

    expect(run(fake.git)).toEqual(real)
    expect(fake.unanswered).toEqual([])
  })
})

/**
 * Run branches beside main, as the loop's run-branch probe and cycle gate ask about them:
 * one kept, one deleted with its commit left behind, a commit another clone pushed to the
 * remote outside its branches, and a remote whose URL names no repository. Each commit's
 * SHA is recorded under the placeholder the invocations below name it by.
 */
function commitsBesideRunBranches(root: string, commits: Record<string, string>): Partial<FakeRepositoryState> {
  const { head = '' } = initialRepository(root)
  const origin = bareRemote(root, 'origin')
  setup(root, 'push', '-q', '-u', 'origin', 'main')
  setup(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  setup(root, 'switch', '-q', '-c', 'run/kept')
  commit(root, 'kept\n')
  const kept = setup(root, 'rev-parse', 'HEAD')
  setup(root, 'switch', '-q', '-c', 'run/deleted', 'main')
  commit(root, 'deleted\n')
  const deleted = setup(root, 'rev-parse', 'HEAD')
  setup(root, 'switch', '-q', 'main')
  setup(root, 'branch', '-q', '-D', 'run/deleted')
  const outsideClone = `${root}-outside`
  execFileSync('git', ['clone', '-q', '--branch', 'main', origin, outsideClone], { windowsHide: true })
  setup(outsideClone, 'config', 'user.email', 'outside@example.test')
  setup(outsideClone, 'config', 'user.name', 'Outside')
  commit(outsideClone, 'outside\n')
  const outside = setup(outsideClone, 'rev-parse', 'HEAD')
  setup(outsideClone, 'push', '-q', 'origin', 'HEAD:refs/outside/run')
  const missing = `${root}-missing.git`
  setup(root, 'remote', 'add', 'missing', missing)
  Object.assign(commits, { '<head>': head, '<kept>': kept, '<deleted>': deleted, '<outside>': outside })
  return {
    head,
    branches: ['main', 'run/kept'],
    remotes: [
      { name: 'missing', url: missing },
      {
        name: 'origin', url: origin, defaultBranch: 'main',
        branches: { main: head }, commits: { [outside]: [head] },
      },
    ],
    upstreams: { main: 'origin' },
    otherCommits: { [kept]: [head], [deleted]: [head] },
    missingRepositories: [missing],
  }
}

// In order: the fetch of the outside commit gives the checkout a commit the questions
// before it could not name.
const COMMIT_INVOCATIONS: string[][] = [
  ['merge-base', '--is-ancestor', '<head>', 'HEAD'],
  ['merge-base', '--is-ancestor', '<kept>', 'HEAD'],
  ['merge-base', '--is-ancestor', '<head>', '<kept>'],
  ['merge-base', '--is-ancestor', '<deleted>', 'HEAD'],
  ['merge-base', '--is-ancestor', '<deleted>', 'origin/main'],
  ['merge-base', '--is-ancestor', '<head>', 'origin/main'],
  ['merge-base', '--is-ancestor', 'f'.repeat(40), 'HEAD'],
  ['merge-base', '--is-ancestor', '<outside>', '<outside>'],
  ['rev-parse', '--verify', 'origin/main^{commit}'],
  ['rev-parse', '--verify', 'origin/absent^{commit}'],
  ['show-ref', '--verify', '--quiet', 'refs/heads/run/kept'],
  ['show-ref', '--verify', '--quiet', 'refs/heads/run/deleted'],
  ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/main'],
  ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/run/kept'],
  ['ls-remote', '--exit-code', '--heads', 'missing', 'refs/heads/main'],
  ['fetch', '--quiet', 'origin', 'main'],
  ['fetch', 'origin', 'main', '--quiet'],
  ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
  ['fetch', '--quiet', 'origin', 'absent'],
  ['fetch', '--quiet', 'missing', 'main'],
  ['fetch', '--quiet', 'origin', 'f'.repeat(40)],
  ['push', '--quiet', 'origin', 'main'],
  ['push', '--quiet', 'missing', 'main'],
  ['fetch', '--quiet', 'origin', '<outside>'],
  ['merge-base', '--is-ancestor', '<head>', '<outside>'],
]

describe('the fake repository against real git on commits beside run branches', () => {
  const commits: Record<string, string> = {}
  let root: string
  let fake: FakeRepository

  beforeAll(() => {
    root = join(workspace, 'commits')
    mkdirSync(root)
    fake = new FakeRepository(root, commitsBesideRunBranches(root, commits))
  })

  it.each([...COMMON_INVOCATIONS, ...COMMIT_INVOCATIONS].map((args) => [args.join(' '), args]))(
    'answers git %s as git does',
    (_invocation, args) => {
      const named = args.map((arg) => commits[arg] ?? arg)
      expect(outcome(fake.git, root, named)).toEqual(outcome(realGit, root, named))
      expect(fake.unanswered).toEqual([])
    },
  )
})

describe('the fake repository on a question it does not know', () => {
  it('refuses it loudly and remembers it', () => {
    const fake = new FakeRepository(workspace)

    expect(() => fake.git(workspace, ['log', '--oneline'])).toThrow(/does not answer git log --oneline/)
    expect(() => fake.assertEveryQuestionAnswered()).toThrow(/git log --oneline/)
  })

  it('refuses a known question asked in another directory', () => {
    const fake = new FakeRepository(workspace)

    expect(() => fake.git(join(workspace, 'elsewhere'), ['rev-parse', 'HEAD']))
      .toThrow(/does not answer git rev-parse HEAD/)
  })

  it('refuses the commit count against a base it was not told about', () => {
    const fake = new FakeRepository(workspace, { commitsAhead: { base: 2 } })

    expect(() => fake.git(workspace, ['rev-list', '--count', 'other..HEAD'])).toThrow(/does not answer/)
  })
})
