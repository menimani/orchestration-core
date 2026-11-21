// The one way the loop reaches git. Production code passes nothing and each caller keeps
// the execFileSync call it always made; a test that describes a repository in memory
// passes its own runner, so the loop's decisions can be exercised without starting git.

export interface GitRunOptions {
  /** The child's whole environment, when it must differ from this process's. */
  env?: NodeJS.ProcessEnv | undefined
}

/**
 * Runs one git invocation in `cwd` and returns its standard output, or throws as
 * execFileSync does when git fails: an Error carrying the exit `status` and the captured
 * `stderr`.
 */
export type GitRunner = (cwd: string, args: string[], options?: GitRunOptions) => string
