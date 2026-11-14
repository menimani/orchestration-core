import { existsSync, rmSync, writeFileSync } from 'node:fs'

/**
 * A daemon installing its dependencies at startup holds this file beside the readiness
 * file its launcher polls. `npm ci` after a lockfile change can outlast any fixed startup
 * deadline, and a launcher that kills the daemon partway through leaves node_modules
 * half emptied, so the launcher waits for the install instead of timing it out.
 */
export function startupInstallingFile(readinessFile: string): string {
  return `${readinessFile}.installing`
}

/** Announce an install to every launcher waiting on this daemon; returns the cleanup. */
export function markStartupInstalling(readinessFiles: (string | undefined)[]): () => void {
  const markers = readinessFiles
    .filter((file): file is string => file !== undefined && file !== '')
    .map(startupInstallingFile)
  for (const marker of markers) writeFileSync(marker, `${process.pid}\n`)
  return () => {
    for (const marker of markers) rmSync(marker, { force: true })
  }
}

/**
 * The deadline a launcher enforces: while the daemon reports an install, the full startup
 * timeout restarts from now, so the rest of initialization keeps its whole allowance.
 */
export function startupDeadline(
  readinessFile: string,
  deadline: number,
  timeoutMs: number,
  now: number = Date.now(),
): number {
  return existsSync(startupInstallingFile(readinessFile))
    ? Math.max(deadline, now + timeoutMs)
    : deadline
}
