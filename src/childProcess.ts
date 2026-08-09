import type { SpawnOptions } from 'node:child_process'

/** Child processes owned by the daemon are captured unless a dedicated log owns them. */
export function capturedSpawnOptions(
  options: Omit<SpawnOptions, 'stdio'> = {},
): SpawnOptions {
  return { ...options, stdio: ['ignore', 'pipe', 'pipe'] }
}
