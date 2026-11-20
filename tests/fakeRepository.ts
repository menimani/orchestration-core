import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { GitRunner } from '../src/gitRunner.ts'
import { branchName, finalMessageFile, logFile, worktreeDir } from '../src/paths.ts'
import { recordTaskProcess } from '../src/processRegistry.ts'
import type { startTask } from '../src/start.ts'
import { writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'

// An in-memory checkout for the loop tests that only need git to answer questions about
// the repository: which branch is checked out, what HEAD is, which remotes exist and how
// the branch is configured to push. It answers exactly the invocations the loop makes, in
// git's own output format, and tests/fake-repository-contract.test.ts asks real git the
// same questions about the same states. Any other invocation is refused and remembered,
// so a question the loop starts asking fails the test instead of getting a made-up answer.

export interface FakeRemote {
  name: string
  url: string
  /** The branch refs/remotes/<name>/HEAD points at, when it is set. */
  defaultBranch?: string | undefined
}

/** A linked worktree, as `git worktree add <path> -b <branch>` leaves it at HEAD. */
export interface FakeWorktree {
  path: string
  branch: string
}

export interface FakeRepositoryState {
  /** False for a directory that is not inside any repository. */
  repository: boolean
  /** The checked-out branch; undefined for a detached HEAD. */
  branch: string | undefined
  head: string
  branches: string[]
  /** Linked worktrees; the checkout at the root is not one of them. */
  worktrees: FakeWorktree[]
  remotes: FakeRemote[]
  /** The remote each branch tracks, as `git push -u <remote> <branch>` records it. */
  upstreams: Record<string, string>
  /** branch.<name>.pushRemote */
  pushRemotes: Record<string, string>
  /** remote.pushDefault */
  pushDefault: string | undefined
  /** Tracked files changed in the working tree. */
  modifiedFiles: string[]
  /** How many commits HEAD has that each named base does not. */
  commitsAhead: Record<string, number>
}

/** The commit the loop tests' fake checkout stands on. */
export const FAKE_HEAD = '5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed'

const NOT_A_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git\n'

/** A path as git prints it: resolved through links, with forward slashes. */
function gitPath(path: string): string {
  let real = resolve(path)
  try {
    real = realpathSync.native(path)
  } catch {
    // A worktree directory removed by hand is still listed until it is pruned.
  }
  return real.split(sep).join('/')
}

/** The error execFileSync throws for a git process that exits with `status`. */
function gitFailure(args: string[], status: number, stderr: string): Error {
  return Object.assign(new Error(`Command failed: git ${args.join(' ')}\n${stderr}`), {
    status, stderr, stdout: '',
  })
}

export class FakeRepository {
  readonly root: string
  readonly state: FakeRepositoryState
  /** Every invocation the fake refused, in order. */
  readonly unanswered: string[] = []

  constructor(root: string, state: Partial<FakeRepositoryState> = {}) {
    this.root = resolve(root)
    const branch = 'branch' in state ? state.branch : 'main'
    this.state = {
      repository: true,
      head: FAKE_HEAD,
      branches: branch === undefined ? [] : [branch],
      worktrees: [],
      remotes: [],
      upstreams: {},
      pushRemotes: {},
      pushDefault: undefined,
      modifiedFiles: [],
      commitsAhead: {},
      ...state,
      branch,
    }
  }

  /** The loop's git port, bound to this repository. */
  readonly git: GitRunner = (cwd, args) => {
    const answer = resolve(cwd) === this.root ? this.answer(args) : undefined
    if (answer === undefined) {
      const invocation = `git ${args.join(' ')} in ${cwd}`
      this.unanswered.push(invocation)
      throw new Error(`The fake repository does not answer ${invocation}; teach it the question `
        + 'and pin the answer against real git in tests/fake-repository-contract.test.ts')
    }
    // git config reads the user's own files outside a repository too, and finds nothing.
    if (!this.state.repository && args[0] !== 'config') {
      throw gitFailure(args, 128, NOT_A_REPOSITORY)
    }
    return answer()
  }

  /** Fails a test whose loop asked a question the fake could not answer. */
  assertEveryQuestionAnswered(): void {
    if (this.unanswered.length > 0) {
      throw new Error(`The fake repository was asked:\n${this.unanswered.join('\n')}`)
    }
  }

  /**
   * startTask without `git worktree add`: the worktree is a plain directory and the task
   * branch exists only here. The runner, the process registry and the status record are
   * the real ones, as startTask leaves them.
   */
  readonly startTask: typeof startTask = async (paths, runner, taskId, options) => {
    const worktree = worktreeDir(paths, taskId)
    mkdirSync(worktree, { recursive: true })
    this.state.branches.push(branchName(taskId))
    this.state.worktrees.push({ path: worktree, branch: branchName(taskId) })
    const log = logFile(paths, taskId)
    writeFileSync(log, '')
    rmSync(finalMessageFile(paths, taskId), { force: true })
    const pid = await runner.start({
      worktree,
      specFile: specFile(paths, taskId),
      finalMessageFile: finalMessageFile(paths, taskId),
      logFile: log,
      effort: options.effort,
      model: options.model,
    })
    recordTaskProcess(paths, taskId, pid)
    await writeStatus(paths, taskId, 'running', pid)
    return { outcome: 'started', pid }
  }

  /** The answer to one invocation, or undefined for one the fake does not know. */
  private answer(args: string[]): (() => string) | undefined {
    const state = this.state
    const lines = (values: string[]): string => values.map((value) => `${value}\n`).join('')
    const configured = (value: string | undefined): () => string => () => {
      if (value === undefined) throw gitFailure(args, 1, '')
      return `${value}\n`
    }
    const remoteNamed = (name: string | undefined): FakeRemote | undefined =>
      state.remotes.find((remote) => remote.name === name)
    const command = args.join(' ')

    if (command === 'branch --show-current') {
      return () => lines(state.branch === undefined ? [] : [state.branch])
    }
    if (command === 'rev-parse HEAD') return () => `${state.head}\n`
    if (command === 'remote') {
      return () => lines(state.remotes.map((remote) => remote.name).sort())
    }
    if (command === 'status --porcelain') {
      return () => lines(state.modifiedFiles.map((file) => ` M ${file}`))
    }
    if (command === 'config --get remote.pushDefault') return configured(state.pushDefault)
    if (command === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
      return () => {
        if (state.branch === undefined) {
          throw gitFailure(args, 128, 'fatal: HEAD does not point to a branch\n')
        }
        const upstream = state.upstreams[state.branch]
        if (upstream === undefined) {
          throw gitFailure(args, 128, `fatal: no upstream configured for branch '${state.branch}'\n`)
        }
        return `${upstream}/${state.branch}\n`
      }
    }

    const branchConfig = /^config --get branch\.(.+)\.(pushRemote|remote)$/.exec(command)
    if (branchConfig !== null) {
      const [, branch = '', key] = branchConfig
      return configured(key === 'remote' ? state.upstreams[branch] : state.pushRemotes[branch])
    }
    const upstreamRemote = /^for-each-ref --format=%\(upstream:remotename\) refs\/heads\/(.+)$/
      .exec(command)
    if (upstreamRemote !== null) {
      const branch = upstreamRemote[1] ?? ''
      return () => (state.branches.includes(branch) ? `${state.upstreams[branch] ?? ''}\n` : '')
    }
    const localBranch = /^show-ref --verify --quiet refs\/heads\/(.+)$/.exec(command)
    if (localBranch !== null) {
      const branch = localBranch[1] ?? ''
      return () => {
        if (!state.branches.includes(branch)) throw gitFailure(args, 1, '')
        return ''
      }
    }
    const remoteHead = /^symbolic-ref --quiet --short refs\/remotes\/(.+)\/HEAD$/.exec(command)
    if (remoteHead !== null) {
      const remote = remoteNamed(remoteHead[1])
      return () => {
        if (remote?.defaultBranch === undefined) throw gitFailure(args, 1, '')
        return `${remote.name}/${remote.defaultBranch}\n`
      }
    }
    const remoteUrl = /^remote get-url (.+)$/.exec(command)
    if (remoteUrl !== null) {
      const remote = remoteNamed(remoteUrl[1])
      return () => {
        if (remote === undefined) throw gitFailure(args, 2, `error: No such remote '${remoteUrl[1]}'\n`)
        return `${remote.url}\n`
      }
    }
    if (command === 'worktree list --porcelain -z') {
      const entry = (path: string, branch: string | undefined): string =>
        `worktree ${gitPath(path)}\0HEAD ${state.head}\0`
        + `${branch === undefined ? 'detached' : `branch refs/heads/${branch}`}\0\0`
      return () => entry(this.root, state.branch)
        + state.worktrees.map((worktree) => entry(worktree.path, worktree.branch)).join('')
    }
    if (command === 'for-each-ref --format=%(refname) refs/heads') {
      return () => lines(state.branches.map((branch) => `refs/heads/${branch}`).sort())
    }
    if (command === 'worktree prune --expire now') {
      return () => {
        state.worktrees = state.worktrees.filter((worktree) => existsSync(worktree.path))
        return ''
      }
    }
    const removeWorktree = /^worktree remove (.+) --force$/.exec(command)
    if (removeWorktree !== null) {
      const path = removeWorktree[1] ?? ''
      return () => {
        const linked = state.worktrees.find((worktree) => resolve(worktree.path) === resolve(path))
        if (linked === undefined) throw gitFailure(args, 128, `fatal: '${path}' is not a working tree\n`)
        rmSync(linked.path, { recursive: true, force: true })
        state.worktrees = state.worktrees.filter((worktree) => worktree !== linked)
        return ''
      }
    }
    const deleteBranch = /^branch -D (.+)$/.exec(command)
    if (deleteBranch !== null) {
      const branch = deleteBranch[1] ?? ''
      return () => {
        const checkout = state.branch === branch
          ? this.root
          : state.worktrees.find((worktree) => worktree.branch === branch)?.path
        if (checkout !== undefined) {
          throw gitFailure(args, 1,
            `error: cannot delete branch '${branch}' used by worktree at '${gitPath(checkout)}'\n`)
        }
        if (!state.branches.includes(branch)) {
          throw gitFailure(args, 1, `error: branch '${branch}' not found.\n`)
        }
        state.branches = state.branches.filter((name) => name !== branch)
        delete state.upstreams[branch]
        delete state.pushRemotes[branch]
        return `Deleted branch ${branch} (was ${state.head.slice(0, 7)}).\n`
      }
    }
    const push = /^push --quiet (\S+) (\S+)$/.exec(command)
    if (push !== null) {
      const [, name = '', branch = ''] = push
      return () => {
        if (remoteNamed(name) === undefined) {
          throw gitFailure(args, 128, `fatal: '${name}' does not appear to be a git repository\n`)
        }
        if (!state.branches.includes(branch)) {
          throw gitFailure(args, 1, `error: src refspec ${branch} does not match any\n`)
        }
        // The remote now holds the branch's HEAD, and so does its remote-tracking ref.
        state.commitsAhead[`${name}/${branch}`] = 0
        return ''
      }
    }
    // Only the remote's default branch is known to exist there; it holds what was fetched.
    const fetch = /^fetch (\S+) (\S+) --quiet$/.exec(command)
    if (fetch !== null && remoteNamed(fetch[1])?.defaultBranch === fetch[2]) return () => ''
    const fetchRef = /^fetch --quiet (\S+) \+refs\/heads\/(\S+):refs\/remotes\/(\S+)\/(\S+)$/.exec(command)
    if (fetchRef !== null && fetchRef[1] === fetchRef[3] && fetchRef[2] === fetchRef[4]
      && remoteNamed(fetchRef[1])?.defaultBranch === fetchRef[2]) {
      return () => ''
    }
    // A ref HEAD has no commits beyond names HEAD itself, and HEAD's log against it is
    // empty; the fake knows no other commit or subject.
    const atHead = (ref: string | undefined): boolean => state.commitsAhead[ref ?? ''] === 0
    const remoteSymref = /^ls-remote --symref (\S+) HEAD$/.exec(command)
    const remoteDefault = remoteNamed(remoteSymref?.[1])?.defaultBranch
    if (remoteSymref !== null && atHead(`${remoteSymref[1]}/${remoteDefault}`)) {
      return () => `ref: refs/heads/${remoteDefault}\tHEAD\n${state.head}\tHEAD\n`
    }
    const verifyCommit = /^rev-parse --verify (.+)\^\{commit\}$/.exec(command)
    if (verifyCommit !== null && atHead(verifyCommit[1])) return () => `${state.head}\n`
    const log = /^log (.+)\.\.HEAD --no-merges --pretty=%H\|%s$/.exec(command)
    if (log !== null && atHead(log[1])) return () => ''
    const ahead = /^rev-list --count (.+)\.\.HEAD$/.exec(command)
    if (ahead !== null && (ahead[1] ?? '') in state.commitsAhead) {
      return () => `${state.commitsAhead[ahead[1] ?? '']}\n`
    }
    return undefined
  }
}
