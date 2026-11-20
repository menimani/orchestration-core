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
  /** remote.<name>.pushurl, which a push uses instead of the url. */
  pushUrl?: string | undefined
  /** The remote's branches, which the checkout's remote-tracking refs match. */
  branches?: Record<string, string> | undefined
  /**
   * Commits the remote holds outside its branches, each with every commit it contains;
   * the checkout has one only once it fetches it by SHA.
   */
  commits?: Record<string, string[]> | undefined
  /** The branch the remote's own HEAD names, which `git ls-remote --symref` advertises. */
  head?: string | undefined
  /**
   * refs/remotes/<name>/<branch>, each at the commit the last fetch or push saw, when they
   * lag the remote's branches; unset, they match them.
   */
  trackingBranches?: Record<string, string> | undefined
}

/** A commit HEAD has beyond a base; the fake knows no merge commits. */
export interface FakeCommit {
  sha: string
  subject: string
  /** The files the commit changes, none of them deleted. */
  files: string[]
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
  /** The remote branch a branch tracks when it is not its namesake (`git branch --set-upstream-to`). */
  upstreamBranches: Record<string, string>
  /** branch.<name>.pushRemote */
  pushRemotes: Record<string, string>
  /** remote.pushDefault */
  pushDefault: string | undefined
  /** Tracked files changed in the working tree. */
  modifiedFiles: string[]
  /** How many commits HEAD has that each named base does not. */
  commitsAhead: Record<string, number>
  /** The commits HEAD has that each named base does not, oldest first. */
  commits: Record<string, FakeCommit[]>
  /** The commits HEAD descends from, other than HEAD itself. */
  ancestors: string[]
  /** The checkout's commits besides HEAD and its ancestors, each with every commit it contains. */
  otherCommits: Record<string, string[]>
  /** Remote URLs that name no repository, so fetching or pushing through them fails. */
  missingRepositories: string[]
  /** Refs whose lock file a crashed git process left behind, so moving them fails. */
  lockedRefs: string[]
}

/** The commit the loop tests' fake checkout stands on. */
export const FAKE_HEAD = '5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed'
/** A commit a test adds on top of FAKE_HEAD. */
export const FAKE_COMMIT = 'c0de0c0de0c0de0c0de0c0de0c0de0c0de0c0de0'
/** A commit a test adds on top of FAKE_COMMIT. */
export const FAKE_LATER_COMMIT = '1a7e1a7e1a7e1a7e1a7e1a7e1a7e1a7e1a7e1a7e'

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
      upstreamBranches: {},
      pushRemotes: {},
      pushDefault: undefined,
      modifiedFiles: [],
      commitsAhead: {},
      commits: {},
      ancestors: [],
      otherCommits: {},
      missingRepositories: [],
      lockedRefs: [],
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
        return `${upstream}/${state.upstreamBranches[state.branch] ?? state.branch}\n`
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
    const missingRepository = (url: string): Error => gitFailure(args, 128,
      `fatal: '${url}' does not appear to be a git repository\n`)
    const push = /^push --quiet( --set-upstream)? (\S+) (\S+)$/.exec(command)
    if (push !== null) {
      const [, setUpstream, name = '', branch = ''] = push
      return () => {
        const remote = remoteNamed(name)
        if (remote === undefined) {
          throw gitFailure(args, 128, `fatal: '${name}' does not appear to be a git repository\n`)
        }
        const url = remote.pushUrl ?? remote.url
        if (state.missingRepositories.includes(url)) throw missingRepository(url)
        if (!state.branches.includes(branch)) {
          throw gitFailure(args, 1, `error: src refspec ${branch} does not match any\n`)
        }
        // The remote now holds the branch's HEAD, and so does its remote-tracking ref.
        state.commitsAhead[`${name}/${branch}`] = 0
        if (remote.branches !== undefined) remote.branches = { ...remote.branches, [branch]: state.head }
        if (remote.trackingBranches !== undefined) {
          remote.trackingBranches = { ...remote.trackingBranches, [branch]: state.head }
        }
        if (setUpstream !== undefined) state.upstreams[branch] = name
        return ''
      }
    }
    const fetchRemote = /^fetch (?:--quiet )?(\S+) /.exec(command)
    const fetchUrl = remoteNamed(fetchRemote?.[1])?.url
    if (fetchUrl !== undefined && state.missingRepositories.includes(fetchUrl)) {
      return () => { throw missingRepository(fetchUrl) }
    }

    const contains = (descendant: string, ancestor: string): boolean => descendant === ancestor
      || (descendant === state.head && state.ancestors.includes(ancestor))
      || (state.otherCommits[descendant] ?? []).includes(ancestor)
    const known = (sha: string): boolean => sha === state.head || state.ancestors.includes(sha)
      || sha in state.otherCommits || Object.values(state.otherCommits).some((held) => held.includes(sha))
    // The commit a name resolves to as git resolves it, null for one git cannot resolve, and
    // undefined when the test did not describe what the name would point at.
    const commitNamed = (name: string): string | null | undefined => {
      if (name === 'HEAD' || state.commitsAhead[name] === 0) return state.head
      const tracking = state.remotes.find((remote) => name.startsWith(`${remote.name}/`))
      if (tracking !== undefined) {
        const refs = tracking.trackingBranches ?? tracking.branches
        if (refs === undefined) return undefined
        return refs[name.slice(tracking.name.length + 1)] ?? null
      }
      if (/^[0-9a-f]{40}$/.test(name)) return known(name) ? name : null
      return undefined
    }

    const remoteBranch = /^ls-remote --exit-code --heads (\S+) refs\/heads\/(\S+)$/.exec(command)
    const listedRemote = remoteNamed(remoteBranch?.[1])
    if (remoteBranch !== null && listedRemote !== undefined
      && (listedRemote.branches !== undefined || state.missingRepositories.includes(listedRemote.url))) {
      const branch = remoteBranch[2] ?? ''
      return () => {
        if (state.missingRepositories.includes(listedRemote.url)) throw missingRepository(listedRemote.url)
        const sha = listedRemote.branches?.[branch]
        if (sha === undefined) throw gitFailure(args, 2, '')
        return `${sha}\trefs/heads/${branch}\n`
      }
    }
    // A remote whose branches the test describes answers a fetch of any branch or commit.
    const fetchAny = /^fetch --quiet (\S+) (\S+)$/.exec(command) ?? /^fetch (\S+) (\S+) --quiet$/.exec(command)
    const fetched = remoteNamed(fetchAny?.[1])
    const refspec = /^\+refs\/heads\/(\S+):refs\/remotes\/(\S+)$/.exec(fetchAny?.[2] ?? '')
    if (fetchAny !== null && fetched?.branches !== undefined
      && (refspec === null || refspec[2] === `${fetched.name}/${refspec[1]}`)) {
      const wanted = refspec?.[1] ?? fetchAny[2] ?? ''
      const branches = fetched.branches
      return () => {
        if (!/^[0-9a-f]{40}$/.test(wanted)) {
          const commit = branches[wanted]
          if (commit === undefined) {
            throw gitFailure(args, 128, `fatal: couldn't find remote ref ${wanted}\n`)
          }
          // A fetch that finds the tracking ref current leaves it, and its lock, alone.
          const ref = `refs/remotes/${fetched.name}/${wanted}`
          if (refspec !== null && fetched.trackingBranches !== undefined
            && fetched.trackingBranches[wanted] !== commit) {
            if (state.lockedRefs.includes(ref)) {
              throw gitFailure(args, 1, `error: cannot lock ref '${ref}': File exists.\n`)
            }
            fetched.trackingBranches = { ...fetched.trackingBranches, [wanted]: commit }
          }
          return ''
        }
        const outside = fetched.commits?.[wanted]
        if (outside !== undefined) {
          state.otherCommits[wanted] = outside
          return ''
        }
        if (!Object.values(branches).some((tip) => contains(tip, wanted))) {
          throw gitFailure(args, 128, `fatal: remote error: upload-pack: not our ref ${wanted}\n`)
        }
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
    // A remote whose own HEAD the test names advertises it only while it holds that branch.
    const advertised = remoteNamed(remoteSymref?.[1])
    if (advertised?.head !== undefined) {
      const head = advertised.head
      return () => {
        const commit = advertised.branches?.[head]
        return commit === undefined ? '' : `ref: refs/heads/${head}\tHEAD\n${commit}\tHEAD\n`
      }
    }
    const remoteDefault = remoteNamed(remoteSymref?.[1])?.defaultBranch
    if (remoteSymref !== null && atHead(`${remoteSymref[1]}/${remoteDefault}`)) {
      return () => `ref: refs/heads/${remoteDefault}\tHEAD\n${state.head}\tHEAD\n`
    }
    const verifyCommit = /^rev-parse --verify (.+)\^\{commit\}$/.exec(command)
    if (verifyCommit !== null && atHead(verifyCommit[1])) return () => `${state.head}\n`
    const verified = verifyCommit === null ? undefined : commitNamed(verifyCommit[1] ?? '')
    if (verified !== undefined) {
      return () => {
        if (verified === null) throw gitFailure(args, 128, 'fatal: Needed a single revision\n')
        return `${verified}\n`
      }
    }
    const log = /^log (.+)\.\.HEAD --no-merges --pretty=%H\|%s$/.exec(command)
    if (log !== null && atHead(log[1])) return () => ''
    // Beyond a base the test lists commits for, the fake knows their subjects and files.
    const since = (ref: string | undefined): FakeCommit[] | undefined =>
      (atHead(ref) ? [] : state.commits[ref ?? ''])
    const commitLog = since(log?.[1])
    if (commitLog !== undefined) {
      return () => lines(commitLog.map((commit) => `${commit.sha}|${commit.subject}`).reverse())
    }
    const merges = /^log (.+)\.\.HEAD --merges --first-parent --reverse --format=%s%x1f%b%x1e$/
      .exec(command)
    if (merges !== null && since(merges[1]) !== undefined) return () => ''
    const changed = /^diff --name-only( --diff-filter=D)? (.+)\.\.HEAD$/.exec(command)
    const changedCommits = since(changed?.[2])
    if (changed !== null && changedCommits !== undefined) {
      const files = changedCommits.flatMap((commit) => commit.files)
      return () => lines(changed[1] === undefined ? [...new Set(files)].sort() : [])
    }
    const shown = /^show --name-only --pretty=format: (\S+)$/.exec(command)
    const shownCommit = Object.values(state.commits).flat().find((commit) => commit.sha === shown?.[1])
    if (shownCommit !== undefined) return () => lines(shownCommit.files)
    const ahead = /^rev-list --count (.+)\.\.HEAD$/.exec(command)
    if (ahead !== null && (ahead[1] ?? '') in state.commitsAhead) {
      return () => `${state.commitsAhead[ahead[1] ?? '']}\n`
    }
    // Whether one commit is contained in another: HEAD in itself only, never in one of its
    // ancestors, and a commit the checkout does not hold is not in the object store at all.
    const isAncestor = /^merge-base --is-ancestor (\S+) (\S+)$/.exec(command)
    const ancestor = isAncestor === null ? undefined : commitNamed(isAncestor[1] ?? '')
    const descendant = isAncestor === null ? undefined : commitNamed(isAncestor[2] ?? '')
    if (isAncestor !== null && ancestor !== undefined && descendant !== undefined) {
      return () => {
        if (ancestor === null || descendant === null) {
          const unknown = ancestor === null ? isAncestor[1] : isAncestor[2]
          throw gitFailure(args, 128, `fatal: Not a valid commit name ${unknown}\n`)
        }
        if (!contains(descendant, ancestor)) throw gitFailure(args, 1, '')
        return ''
      }
    }
    const fetchCommit = /^fetch --quiet (\S+) ([0-9a-f]{40})$/.exec(command)
    if (fetchCommit !== null && remoteNamed(fetchCommit[1]) !== undefined
      && fetchCommit[2] !== state.head && !state.ancestors.includes(fetchCommit[2] ?? '')) {
      return () => {
        throw gitFailure(args, 128, `fatal: remote error: upload-pack: not our ref ${fetchCommit[2]}\n`)
      }
    }
    return undefined
  }
}
