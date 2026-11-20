import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// Beside the work tree rather than in it, where it would be an untracked directory.
function bareRemote(root: string, name: string): string {
  const remote = `${root}-${name}.git`
  execFileSync('git', ['init', '-q', '--bare', remote], { windowsHide: true })
  setup(root, 'remote', 'add', name, remote)
  return remote
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
