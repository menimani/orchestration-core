import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process'

/** Execute a project-supplied command with Node's platform-default command shell. */
export function execShellSync(
  command: string,
  options: ExecSyncOptionsWithStringEncoding,
): string {
  return execSync(command, options)
}
