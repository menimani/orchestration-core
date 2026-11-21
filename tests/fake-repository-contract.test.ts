import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Runner } from '../src/adapters/runner.ts'
import type { GitRunner } from '../src/gitRunner.ts'
import { logFile, orchPaths, rebaseEmptiedMarkerFile } from '../src/paths.ts'
import { forgetTaskProcess, taskProcessPid } from '../src/processRegistry.ts'
import { startTask } from '../src/start.ts'
import { readStatus } from '../src/status.ts'
import { failedTaskLeftover, specFile } from '../src/tasks.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import {
  FAKE_COMMIT, FAKE_HEAD, FakeRepository, type FakeRepositoryState,
} from './fakeRepository.ts'
import { unmarkFakeRoot } from './realGitGuard.ts'

// The fake repository stands in for git in the loop tests, so its answers are only worth
// what this file proves: every state it distinguishes is built in a real repository, and
// every invocation it answers is asked of real git and of the fake, which must agree on
// the output, or on the failure status and text. This file runs real git on purpose.

const realGit: GitRunner = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  // The rest comes from tests/gitIsolation.ts, which also keeps git's messages untranslated.
  // A directory outside every repository must not find one above the temporary root.
  env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
})

type Outcome = { output: string } | { status: number | null, stderr: string }

// The failures whose text the loop matches on or reports, compared whole. src/loop.ts
// matches a refspec fetch's reason and reports the reasons of fetch, push, merge-base,
// rev-list and rev-parse --verify; cleanup reports why a worktree removal failed. Every
// other failure is compared by the first line of its standard error.
const REPORTED_FAILURES = [/^fetch /, /^push /, /^merge-base /, /^rev-list /, /^rev-parse --verify /, /^worktree remove /]

interface VersionWording {
  /** The message as the fake prints it; `$<name>` stands for a captured path or ref. */
  canonical: string
  /** Every spelling git has been seen to print, each a whole line or run of lines. */
  spellings: RegExp[]
}

// git words some messages differently from one version to another, and the suite runs on
// several: 2.39 in the node:24-bookworm container of `npm run test:linux`, 2.44 on the
// Windows development host, and 2.56 on GitHub Actions. The fake prints one spelling of
// each, so both sides of every standard-error comparison pass through this table, which
// maps each observed spelling to that one. It lists only what was observed, and none of
// these texts decides anything in src/. Text it does not know passes through unchanged,
// so a drift in any other message, or a wording a later git introduces, still fails the
// contract and names itself.
const VERSION_WORDINGS: VersionWording[] = [
  {
    canonical: 'Another git process seems to be running in this repository, e.g.\n'
      + "an editor opened by 'git commit'. Please make sure all processes\n"
      + 'are terminated then try again. If it still fails, a git process\n'
      + 'may have crashed in this repository earlier:\nremove the file manually to continue.',
    spellings: [
      // 2.39 and 2.44.
      new RegExp("^Another git process seems to be running in this repository, e\\.g\\.\\nan editor opened by 'git commit'\\. "
        + 'Please make sure all processes\\nare terminated then try again\\. If it still fails, a git process\\n'
        + 'may have crashed in this repository earlier:\\nremove the file manually to continue\\.$', 'gm'),
      // 2.56.
      /^Another git process seems to be running in this repository, or the lock file may be stale$/gm,
    ],
  },
  {
    canonical: "error: cannot delete branch '$<branch>' used by worktree at '$<path>'",
    spellings: [
      // 2.39.
      /^error: Cannot delete branch '(?<branch>[^'\n]+)' checked out at '(?<path>[^'\n]+)'$/gm,
      // 2.44 and 2.56.
      /^error: cannot delete branch '(?<branch>[^'\n]+)' used by worktree at '(?<path>[^'\n]+)'$/gm,
    ],
  },
  {
    canonical: "error: branch '$<branch>' not found",
    spellings: [
      // 2.39.
      /^error: branch '(?<branch>[^'\n]+)' not found\.$/gm,
      // 2.44 and 2.56.
      /^error: branch '(?<branch>[^'\n]+)' not found$/gm,
    ],
  },
]

/** Rewrites each version-dependent spelling VERSION_WORDINGS lists to the fake's one. */
function versionNeutral(stderr: string): string {
  return VERSION_WORDINGS.reduce((text, wording) => wording.spellings.reduce(
    (rewritten, spelling) => rewritten.replace(spelling, wording.canonical), text), stderr)
}

function outcome(run: GitRunner, cwd: string, args: string[]): Outcome {
  try {
    return { output: run(cwd, args) }
  } catch (error) {
    const failure = error as { status?: number | null, stderr?: string | Buffer }
    // For a remote on a local path git starts upload-pack as a second process, and the two
    // write to the same stream in whichever order they get there, so that process's own
    // lines are compared after git's.
    const written = String(failure.stderr ?? '').split(/(?<=\n)/)
    const uploadPack = (line: string): boolean => line.startsWith('fatal: git upload-pack: ')
    const stderr = versionNeutral(
      [...written.filter((line) => !uploadPack(line)), ...written.filter(uploadPack)].join(''))
    const whole = REPORTED_FAILURES.some((reported) => reported.test(args.join(' ')))
    return { status: failure.status ?? null, stderr: whole ? stderr : stderr.split('\n')[0] ?? '' }
  }
}

// This file asks real git in the fake's root on purpose, so it does not mark the root.
function fakeAt(root: string, state: Partial<FakeRepositoryState>): FakeRepository {
  const fake = new FakeRepository(root, state)
  unmarkFakeRoot(fake.root)
  return fake
}

/** Fails unless the fake refuses the invocation as one it does not know. */
function expectRefused(fake: FakeRepository, root: string, args: string[]): void {
  expect(() => fake.git(root, args)).toThrow(`does not answer git ${args.join(' ')}`)
}

interface ContractState {
  name: string
  /** Builds the state in `root` and returns how the fake describes it. */
  build: (root: string) => Partial<FakeRepositoryState>
  /** Invocations only this state can answer, asked in addition to the common ones. */
  extra?: string[][]
  /** Invocations real git answers in this state that the fake cannot describe, so refuses. */
  refused?: string[][]
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
    extra: [['worktree', 'list', '--porcelain', '-z'], ['branch', '--list', 'main']],
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
      ['rev-parse', 'refs/remotes/origin/main'],
      ['rev-parse', 'refs/remotes/origin/absent'],
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
    extra: [['rev-list', '--count', 'base..HEAD'], ['rev-parse', 'main'], ['branch', '--list', 'base']],
    refused: [['rev-parse', 'base']],
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
      ['rev-parse', 'refs/remotes/origin/main'],
    ],
  },
  {
    name: 'a task worktree on its own branch',
    build: (root) => taskWorktree(root, initialRepository(root)),
    extra: [
      ['worktree', 'list', '--porcelain', '-z'],
      ['for-each-ref', '--format=%(refname)', 'refs/heads'],
      ['rev-parse', 'main'],
      ['rev-parse', 'task/one'],
      ['branch', '--list', 'main'],
      ['branch', '--list', 'task/one'],
      ['branch', '--list', 'absent'],
    ],
    // git matches the pattern and lists task/one.
    refused: [['branch', '--list', 'task/*']],
  },
  {
    name: 'a directory outside every repository',
    build: () => ({ repository: false }),
  },
  {
    name: 'a tracked file changed beside an untracked file',
    build: (root) => {
      const state = initialRepository(root)
      writeFileSync(join(root, 'tracked.txt'), 'changed\n')
      writeFileSync(join(root, 'untracked.txt'), 'untracked\n')
      return { ...state, modifiedFiles: ['tracked.txt'], untrackedFiles: ['untracked.txt'] }
    },
  },
  {
    name: 'an unborn branch with an untracked file',
    build: (root) => {
      setup(root, 'init', '-q', '--initial-branch=main')
      writeFileSync(join(root, 'untracked.txt'), 'untracked\n')
      return { unborn: true, untrackedFiles: ['untracked.txt'] }
    },
    extra: [
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      ['for-each-ref', '--format=%(refname)', 'refs/heads'],
    ],
    refused: [
      ['worktree', 'list', '--porcelain', '-z'],
      ['merge-base', '--is-ancestor', 'HEAD', 'HEAD'],
    ],
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
        fake = fakeAt(root, state.build(root))
      })

      it.each([...COMMON_INVOCATIONS, ...(state.extra ?? [])].map((args) => [args.join(' '), args]))(
        'answers git %s as git does',
        (_invocation, args) => {
          expect(outcome(fake.git, root, args)).toEqual(outcome(realGit, root, args))
          expect(fake.unanswered).toEqual([])
        },
      )

      if (state.refused !== undefined) {
        it.each(state.refused.map((args) => [args.join(' '), args]))(
          'refuses git %s, which it cannot describe',
          (_invocation, args) => expectRefused(fake, root, args),
        )
      }
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
    const fake = fakeAt(root, state)

    expect(run(fake.git)).toEqual(real)
    expect(fake.unanswered).toEqual([])
  })
})

// A task worktree's branch stays at the commit `git worktree add` created it at while the
// run branch moves on. Real git adds the worktree, commits on main and answers first;
// the fake adds the worktree, is moved to the same commit, and answers the same steps.
describe('the fake repository against real git, after HEAD moves past a task worktree', () => {
  it('answers the worktree branch at the commit it was created at as git does', () => {
    const root = join(workspace, 'moved')
    mkdirSync(root)
    const { head: created = '' } = initialRepository(root)
    const worktree = `${root}-task`
    const add = ['worktree', 'add', '--quiet', worktree, '-b', 'task/one']
    const steps: string[][] = [
      ['rev-parse', 'HEAD'],
      ['rev-parse', 'main'],
      ['rev-parse', 'task/one'],
      ['worktree', 'list', '--porcelain', '-z'],
      ['branch', '--list', 'task/one'],
      ['worktree', 'remove', worktree, '--force'],
      ['rev-parse', 'task/one'],
      ['branch', '-D', 'task/one'],
    ]
    const run = (git: GitRunner) => steps.map((args) => ({
      args: args.join(' '), outcome: outcome(git, root, args),
    }))

    const realAdded = outcome(realGit, root, add)
    commit(root, 'moved\n')
    const moved = setup(root, 'rev-parse', 'HEAD')
    const real = run(realGit)
    const fake = fakeAt(root, { head: created })
    const fakeAdded = outcome(fake.git, root, add)
    fake.state.head = moved
    fake.state.ancestors = [created]

    expect(fakeAdded).toEqual(realAdded)
    expect(run(fake.git)).toEqual(real)
    expect(real[2]?.outcome).toEqual({ output: `${created}\n` })
    expect(fake.unanswered).toEqual([])
    expect(fake.contradictions).toEqual([])
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
    const fake = fakeAt(root, state)

    expect(run(fake.git)).toEqual(real)
    expect(fake.unanswered).toEqual([])
  })
})

// origin's default branch advanced after the checkout last fetched it. Real git fetches
// first, and the fake then answers the same steps from the state real git started in.
describe('the fake repository against real git, refreshing a stale remote-tracking branch', () => {
  it('moves the remote-tracking branch to the commit origin holds as git does', () => {
    const root = join(workspace, 'refresh')
    mkdirSync(root)
    initialRepository(root)
    const url = bareRemote(root, 'origin')
    setup(root, 'push', '-q', '-u', 'origin', 'main')
    remoteHead(url, 'main')
    const stale = setup(root, 'rev-parse', 'HEAD')
    commit(root, 'advanced\n')
    const advanced = setup(root, 'rev-parse', 'HEAD')
    setup(root, 'push', '-q', 'origin', 'main')
    setup(root, 'update-ref', 'refs/remotes/origin/main', stale)
    const state: Partial<FakeRepositoryState> = {
      head: advanced,
      remotes: [{
        name: 'origin', url, defaultBranch: 'main', head: 'main',
        branches: { main: advanced }, trackingBranches: { main: stale },
      }],
      upstreams: { main: 'origin' },
    }
    const steps: string[][] = [
      ['rev-parse', 'refs/remotes/origin/main'],
      ['rev-parse', 'refs/remotes/origin/absent'],
      ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['rev-parse', 'refs/remotes/origin/main'],
    ]
    const run = (git: GitRunner) => steps.map((args) => ({
      args: args.join(' '), outcome: outcome(git, root, args),
    }))

    const real = run(realGit)
    const fake = fakeAt(root, state)

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
    const fake = fakeAt(root, state)

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
    const fake = fakeAt(root, state)

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
    const fake = fakeAt(root, state)

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
    const fake = fakeAt(root, state)

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
    fake = fakeAt(root, commitsBesideRunBranches(root, commits))
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

// The loop tests start tasks through the fake, which runs the real startTask and answers
// only its \`git worktree add\`. Real git starts the same task in one checkout and the fake
// in another directory standing for the same state; the outcomes, the status record, the
// log, the recorded process and the worktree and branch git then lists must agree, for a
// first start, a start over a task still running and one over a worktree left without
// an owner.
describe('the fake repository against real git, starting a task', () => {
  it('starts, skips and refuses a task as startTask on git does', async () => {
    const realRoot = join(workspace, 'start-real')
    const fakeRoot = join(workspace, 'start-fake')
    mkdirSync(realRoot)
    mkdirSync(fakeRoot)
    const fake = new FakeRepository(fakeRoot, initialRepository(realRoot))
    const taskId = '20260809_000000_001_auto-contract-start'
    const setupSteps = [{
      label: 'Write setup output',
      cwd: '',
      command: 'node -e "console.log(42)"',
    }]

    const gitPath = (path: string): string => realpathSync.native(path).split(sep).join('/')
    const run = async (root: string, git: GitRunner | undefined) => {
      const paths = orchPaths(root)
      const normalize = (text: string): string =>
        text.split(root).join('<root>').split(gitPath(root)).join('<root>')
      writeFileSync(specFile(paths, taskId), '# contract start\n')
      mkdirSync(join(paths.queueDir, 'rebase-emptied'), { recursive: true })
      writeFileSync(rebaseEmptiedMarkerFile(paths, taskId), '')
      writeFileSync(join(paths.queueDir, 'announced-failures.txt'), `${taskId}\n`)
      const reported: string[] = []
      const runner: Runner = { sharedSkills: fakeRunnerSharedSkills, start: async () => process.pid }
      const options = { effort: 'medium' as const, setup: setupSteps, report: (line: string) => { reported.push(line) } }
      const start = async (): Promise<unknown> => {
        try {
          return git === undefined
            ? await startTask(paths, runner, taskId, options)
            : await startTask(paths, runner, taskId, options, git)
        } catch (error) {
          return { error: normalize((error as Error).message) }
        }
      }
      const status = () => {
        const record = readStatus(paths, taskId)
        return record === undefined ? undefined : {
          ...record, started_at: '', updated_at: '', worktree: normalize(record.worktree),
        }
      }
      const listed = () => normalize((git ?? realGit)(root, ['worktree', 'list', '--porcelain', '-z'])
        + (git ?? realGit)(root, ['for-each-ref', '--format=%(refname)', 'refs/heads']))

      const first = {
        result: await start(),
        status: status(),
        log: normalize(readFileSync(logFile(paths, taskId), 'utf8')),
        process: taskProcessPid(paths, taskId),
        rebaseEmptied: existsSync(rebaseEmptiedMarkerFile(paths, taskId)),
        announced: readFileSync(join(paths.queueDir, 'announced-failures.txt'), 'utf8'),
        listed: listed(),
      }
      const running = { result: await start(), status: status() }
      forgetTaskProcess(paths, taskId)
      const leftover = { result: await start(), status: status(), listed: listed() }
      return { first, running, leftover, reported: reported.map(normalize) }
    }

    const real = await run(realRoot, undefined)
    const faked = await run(fakeRoot, fake.git)

    expect(faked).toEqual(real)
    expect(real.first.result).toEqual({ outcome: 'started', pid: process.pid })
    expect(real.first.status).toMatchObject({ status: 'running', pid: process.pid })
    expect(real.first.log).toBe('42\n')
    expect(real.first.process).toBe(process.pid)
    expect(real.first.rebaseEmptied).toBe(false)
    expect(real.first.announced).toBe('')
    expect(real.first.listed).toContain(`refs/heads/task/${taskId}`)
    expect(real.running.result).toEqual({ outcome: 'already-running' })
    expect(real.leftover.result).toEqual({ error: expect.stringContaining('without a live owner') })
    expect(fake.unanswered).toEqual([])
  })
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

  // The fake moves no commit, so a loop test that the loop merged nothing holds only while
  // every git that would move one is refused and fails the test.
  it.each([
    ['merge', '--quiet', '--no-ff', 'task/one', '-m', 'Merge task/one via orchestration'],
    ['commit', '-q', '-m', 'fix: a change'],
    ['reset', '--hard', FAKE_COMMIT],
    ['branch', '-f', 'main', FAKE_COMMIT],
    ['update-ref', 'refs/heads/main', FAKE_COMMIT, FAKE_HEAD],
  ].map((args) => [args.join(' '), args]))('refuses git %s, which would move a commit', (invocation, args) => {
    const fake = new FakeRepository(workspace, { branches: ['main', 'task/one'] })

    expect(() => fake.git(workspace, args)).toThrow(`does not answer git ${invocation} in ${workspace}`)
    expect(fake.state.head).toBe(FAKE_HEAD)
    expect(fake.unanswered).toEqual([`git ${invocation} in ${workspace}`])
    expect(() => fake.assertEveryQuestionAnswered())
      .toThrow(`The fake repository was asked:\ngit ${invocation} in ${workspace}`)
  })

  it.each(['task/*', 'task/?ne', 'task/[o]ne'])('refuses a branch list matching the pattern %s', (pattern) => {
    const fake = new FakeRepository(workspace, { branches: ['main', 'task/one'] })

    expectRefused(fake, workspace, ['branch', '--list', pattern])
    expect(() => fake.assertEveryQuestionAnswered()).toThrow(`git branch --list ${pattern} in ${workspace}`)
  })
})

// Commits made one second apart, so git log orders them the same on every host.
function datedGit(root: string, second: number, ...args: string[]): void {
  const date = `${1_800_000_000 + second} +0000`
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
}

function commitAt(root: string, file: string, subject: string, second: number): void {
  writeFileSync(join(root, file), `${subject}\n`)
  setup(root, 'add', file)
  datedGit(root, second, 'commit', '-q', '-m', subject)
}

// A side branch merged into main beyond a base: the fake places the merge among the
// commits beyond the base, but knows neither its parents nor its body.
describe('the fake repository against real git, beyond a merge commit', () => {
  it('answers what it describes of the merge and refuses the rest as unknown', () => {
    const root = join(workspace, 'merge')
    mkdirSync(root)
    const { head: initial = '' } = initialRepository(root)
    setup(root, 'branch', 'base')
    setup(root, 'switch', '-q', '-c', 'side')
    commitAt(root, 'side.txt', 'feat: on the side', 1)
    const side = setup(root, 'rev-parse', 'HEAD')
    setup(root, 'switch', '-q', 'main')
    commitAt(root, 'main.txt', 'feat: on main', 2)
    const main = setup(root, 'rev-parse', 'HEAD')
    datedGit(root, 3, 'merge', '--no-ff', '-q', '-m', "Merge branch 'side'", 'side')
    const merge = setup(root, 'rev-parse', 'HEAD')
    const fake = fakeAt(root, {
      head: merge,
      branches: ['main', 'base', 'side'],
      ancestors: [initial, side, main],
      commitsAhead: { base: 3 },
      commits: {
        base: [
          { sha: side, subject: 'feat: on the side', files: ['side.txt'] },
          { sha: main, subject: 'feat: on main', files: ['main.txt'] },
          { sha: merge, subject: "Merge branch 'side'", files: ['side.txt'], merge: true },
        ],
      },
    })
    const answered: string[][] = [
      ['rev-list', '--count', 'base..HEAD'],
      ['log', 'base..HEAD', '--no-merges', '--pretty=%H|%s'],
      ['diff', '--name-only', 'base..HEAD'],
      ['diff', '--name-only', '--diff-filter=D', 'base..HEAD'],
      ['show', '--name-only', '--pretty=format:', side],
      ['merge-base', '--is-ancestor', side, 'HEAD'],
      ['merge-base', '--is-ancestor', 'HEAD', side],
    ]
    const mergeLog = ['log', 'base..HEAD', '--merges', '--first-parent', '--reverse', '--format=%s%x1f%b%x1e']

    for (const args of answered) {
      expect(outcome(fake.git, root, args), args.join(' ')).toEqual(outcome(realGit, root, args))
    }
    expect(realGit(root, mergeLog)).toContain("Merge branch 'side'")
    expectRefused(fake, root, mergeLog)
    expectRefused(fake, root, ['show', '--name-only', '--pretty=format:', merge])
    expect(fake.unanswered).toHaveLength(2)
  })
})

// Another clone pushed to origin's main, which the checkout fetched without moving HEAD:
// HEAD is no commit beyond origin/main, which is one beyond HEAD.
describe('the fake repository against real git, behind its remote-tracking branch', () => {
  it('counts the commits on each side and refuses what needs the commit it lacks', () => {
    const root = join(workspace, 'behind')
    mkdirSync(root)
    const pushed = pushedToOrigin(root, initialRepository(root))
    const outsideClone = `${root}-outside`
    execFileSync('git', ['clone', '-q', '--branch', 'main', pushed.remotes?.[0]?.url ?? '', outsideClone],
      { windowsHide: true })
    setup(outsideClone, 'config', 'user.email', 'outside@example.test')
    setup(outsideClone, 'config', 'user.name', 'Outside')
    commit(outsideClone, 'outside\n')
    setup(outsideClone, 'push', '-q', 'origin', 'main')
    setup(root, 'fetch', '-q', 'origin')
    const fake = fakeAt(root, {
      ...pushed, commitsAhead: { 'origin/main': 0 }, commitsBehind: { 'origin/main': 1 },
    })
    const answered: string[][] = [
      ['rev-list', '--count', 'origin/main..HEAD'],
      ['rev-list', '--count', 'HEAD..origin/main'],
      ['log', 'origin/main..HEAD', '--no-merges', '--pretty=%H|%s'],
      ['log', 'origin/main..HEAD', '--merges', '--first-parent', '--reverse', '--format=%s%x1f%b%x1e'],
    ]
    const refused: string[][] = [
      ['rev-parse', '--verify', 'origin/main^{commit}'],
      ['diff', '--name-only', 'origin/main..HEAD'],
      ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'],
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['push', '--quiet', 'origin', 'main'],
    ]

    for (const args of answered) {
      expect(outcome(fake.git, root, args), args.join(' ')).toEqual(outcome(realGit, root, args))
    }
    for (const args of refused) expectRefused(fake, root, args)
    expect(fake.unanswered).toHaveLength(refused.length)
  })
})

describe('the fake repository on a state no history can produce', () => {
  const origin = (main: string) => [{ name: 'origin', url: 'origin.git', branches: { main } }]
  const IMPOSSIBLE: [string, Partial<FakeRepositoryState>, string][] = [
    ['HEAD among its own ancestors', { ancestors: [FAKE_HEAD] },
      `HEAD ${FAKE_HEAD} is listed among its own ancestors`],
    ['an ancestor listed twice', { head: FAKE_COMMIT, ancestors: [FAKE_HEAD, FAKE_HEAD] },
      `ancestor ${FAKE_HEAD} is listed twice`],
    ['more commits beyond a base than the listed history holds',
      { head: FAKE_COMMIT, ancestors: [FAKE_HEAD], commitsAhead: { base: 3 } },
      'HEAD is 3 commits beyond base, yet its history holds only 2'],
    ['a newest commit beyond a base other than HEAD', {
      commitsAhead: { 'upstream/trunk': 1 },
      commits: { 'upstream/trunk': [{ sha: FAKE_COMMIT, subject: 'feat: a change', files: ['a.txt'] }] },
    }, `the newest commit beyond upstream/trunk is ${FAKE_COMMIT}, yet HEAD is ${FAKE_HEAD}`],
    ['a commit beyond a base outside HEAD\'s history', {
      head: FAKE_COMMIT,
      commits: {
        base: [
          { sha: FAKE_HEAD, subject: 'feat: first', files: ['a.txt'] },
          { sha: FAKE_COMMIT, subject: 'feat: second', files: ['b.txt'] },
        ],
      },
    }, `commit ${FAKE_HEAD} beyond base is neither HEAD nor one of its ancestors`],
    ['a count that disagrees with the commits listed', {
      head: FAKE_COMMIT, ancestors: [FAKE_HEAD], commitsAhead: { base: 2 },
      commits: { base: [{ sha: FAKE_COMMIT, subject: 'feat: a change', files: ['a.txt'] }] },
    }, 'HEAD is 2 commits beyond base, yet 1 are listed beyond it'],
    ['a merge commit with no commit before it', {
      commits: { base: [{ sha: FAKE_HEAD, subject: "Merge branch 'side'", files: [], merge: true }] },
    }, "a merge commit beyond base has two parents, yet HEAD's history holds only 1 commits"],
    ['a remote-tracking branch at HEAD with commits beyond it',
      { remotes: origin(FAKE_HEAD), commitsBehind: { 'origin/main': 1 } },
      'origin/main is at HEAD, yet commits lie between them'],
    ['a remote-tracking branch at an ancestor HEAD is no commit beyond',
      { head: FAKE_COMMIT, ancestors: [FAKE_HEAD], remotes: origin(FAKE_HEAD), commitsAhead: { 'origin/main': 0 } },
      `origin/main is at ${FAKE_HEAD}, an ancestor of HEAD, yet HEAD is no commit beyond it`],
    ['a remote-tracking branch at an ancestor that is beyond HEAD',
      { head: FAKE_COMMIT, ancestors: [FAKE_HEAD], remotes: origin(FAKE_HEAD), commitsBehind: { 'origin/main': 1 } },
      `origin/main is at ${FAKE_HEAD}, an ancestor of HEAD, yet it is 1 commits beyond HEAD`],
    ['a remote-tracking branch its counts name HEAD at another commit',
      { remotes: origin(FAKE_COMMIT), commitsAhead: { 'origin/main': 0 } },
      `neither HEAD nor origin/main is a commit beyond the other, so origin/main is HEAD, yet it is at ${FAKE_COMMIT}`],
    ['a commit beside HEAD\'s history that is in it', { otherCommits: { [FAKE_HEAD]: [] } },
      `otherCommits lists ${FAKE_HEAD} beside HEAD's history, yet it is in it`],
    ['an unborn branch with an ancestor', { unborn: true, ancestors: [FAKE_HEAD] },
      'an unborn HEAD has no commit, yet ancestors is not empty'],
    ['an unborn branch that has a ref', { unborn: true, branches: ['main'] },
      'the unborn branch main has no ref yet, yet branches lists it'],
  ]

  it.each(IMPOSSIBLE)('refuses to be built on %s', (_name, state, contradiction) => {
    expect(() => new FakeRepository(workspace, state))
      .toThrow(`The fake repository describes a state no history can produce: ${contradiction}`)
  })

  it('fails the test whose state becomes impossible before the next answer', () => {
    const fake = new FakeRepository(workspace)
    fake.state.head = FAKE_COMMIT
    fake.state.ancestors = [FAKE_COMMIT]

    expect(() => fake.git(workspace, ['rev-parse', 'HEAD']))
      .toThrow(`HEAD ${FAKE_COMMIT} is listed among its own ancestors`)
    expect(() => fake.assertEveryQuestionAnswered()).toThrow('The fake repository was asked to answer '
      + `from an impossible state: HEAD ${FAKE_COMMIT} is listed among its own ancestors`)
  })
})

// The loop tests' checkout is a plain directory, so production code that starts git there
// itself, past the seam, fails where git would not. The fake's end-of-test check names
// the code that did.
describe('the fake repository on real git started in its root', () => {
  it('fails the test with the caller that started it', () => {
    const root = join(workspace, 'guarded')
    mkdirSync(root)
    const fake = new FakeRepository(root)

    try {
      failedTaskLeftover(orchPaths(root, false), 'guarded-task')
    } catch {
      // Outside a repository git exits 128, which the lookup rethrows.
    }

    expect(() => fake.assertEveryQuestionAnswered()).toThrow(new RegExp(
      "^Real git ran in the fake repository's root, past the git seam:\\n"
      + 'git show-ref --verify --quiet refs/heads/task/guarded-task in .+, started by src/tasks\\.ts:\\d+',
    ))
  })

  it('records git pointed into its root with -C', () => {
    const root = join(workspace, 'pointed')
    mkdirSync(root)
    const fake = new FakeRepository(root)

    realGit(workspace, ['-C', root, '--version'])

    expect(() => fake.assertEveryQuestionAnswered()).toThrow(
      /^Real git ran in the fake repository's root, past the git seam:\ngit -C .+ --version in .+, started by tests\/fake-repository-contract\.test\.ts:\d+/,
    )
  })

  it('leaves git started outside its root alone', () => {
    const root = join(workspace, 'unguarded')
    mkdirSync(root)
    const fake = new FakeRepository(root)

    realGit(workspace, ['--version'])
    realGit(root, ['-C', workspace, '--version'])

    expect(fake.realGit).toEqual([])
    expect(() => fake.assertEveryQuestionAnswered()).not.toThrow()
  })
})

// The table above is the only allowance the comparison makes for git's version, so it is
// pinned itself: each spelling it lists, quoted as the version that printed it.
describe('the version-dependent wordings of git', () => {
  const lockFailure = "error: cannot lock ref 'refs/remotes/origin/main': Unable to create "
    + "'/work/root/.git/refs/remotes/origin/main.lock': File exists.\n\n"
  const observed: string[][] = [
    [
      lockFailure + 'Another git process seems to be running in this repository, e.g.\n'
        + "an editor opened by 'git commit'. Please make sure all processes\n"
        + 'are terminated then try again. If it still fails, a git process\n'
        + 'may have crashed in this repository earlier:\nremove the file manually to continue.\n',
      lockFailure + 'Another git process seems to be running in this repository, or the lock file may be stale\n',
    ],
    [
      "error: Cannot delete branch 'task/one' checked out at '/work/root/.orch/worktrees/one'\n",
      "error: cannot delete branch 'task/one' used by worktree at '/work/root/.orch/worktrees/one'\n",
    ],
    [
      "error: branch 'task/one' not found.\n",
      "error: branch 'task/one' not found\n",
    ],
  ]

  it('quotes one observed text for every spelling the table lists', () => {
    expect(observed.map((texts) => texts.length)).toEqual(VERSION_WORDINGS.map((wording) => wording.spellings.length))
    VERSION_WORDINGS.forEach((wording, message) => wording.spellings.forEach((spelling, index) => {
      expect(observed[message]?.[index]?.match(new RegExp(spelling.source, 'm'))).not.toBeNull()
    }))
  })

  it('maps every spelling of a message to the one the fake prints', () => {
    expect(observed.map((texts) => texts.map(versionNeutral))).toEqual([
      [observed[0]?.[0], observed[0]?.[0]],
      [observed[1]?.[1], observed[1]?.[1]],
      [observed[2]?.[1], observed[2]?.[1]],
    ])
  })

  it('never maps two different messages to the same text', () => {
    const canonical = observed.map((texts) => versionNeutral(texts[0] ?? ''))

    expect(new Set(canonical).size).toBe(observed.length)
  })

  it('leaves a text outside the table unchanged, even one word away from a listed spelling', () => {
    const unknown = [
      "fatal: couldn't find remote ref refs/heads/absent\n",
      lockFailure + 'Another git process seems to be running in this repository, or the lock file may be old\n',
      lockFailure + 'Another git process seems to be running in this repository, e.g.\n'
        + "an editor opened by 'git commit'. Please make sure all processes\n"
        + 'are terminated then try again. If it still fails, a git process\n'
        + 'may have crashed in this repository earlier:\nremove the file manually to proceed.\n',
      "error: Cannot delete branch 'task/one' used by worktree at '/work/root/.orch/worktrees/one'\n",
      "error: cannot delete branch 'task/one' checked out in '/work/root/.orch/worktrees/one'\n",
      "error: branch 'task/one' not found!\n",
      "error: remote branch 'task/one' not found\n",
      "warning: branch 'task/one' not found\n",
    ]

    expect(unknown.map(versionNeutral)).toEqual(unknown)
  })
})
