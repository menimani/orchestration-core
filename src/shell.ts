import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process'
import { projectCommandEnvironment } from './internalEnvironment.ts'

/** Execute a project command without exposing the core's private process metadata. */
export function execShellSync(
  command: string,
  options: ExecSyncOptionsWithStringEncoding,
): string {
  return execSync(command, {
    ...options,
    env: projectCommandEnvironment(options.env ?? process.env),
  })
}
