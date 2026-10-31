import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Fixture directories this suite creates under the OS temporary directory, and how old one
// must be before a later run may take it for abandoned.
//
// Per-test cleanup never runs when a vitest worker is killed, so a host that runs the suite
// often accumulates fixtures — and the daemons some of them launched. Sibling worktrees run
// the suite concurrently, so a recent fixture may belong to a live run and is left alone.
const FIXTURE_PREFIXES = [
  'orch-', 'orch runner-survival-', 'orchestration-shell-', 'orchestration-windows-launch-',
]
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

export function sweepStaleFixtures(tmpRoot: string, now = Date.now()): number {
  const cutoff = now - STALE_AFTER_MS
  let removed = 0
  for (const entry of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!FIXTURE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
    const path = join(tmpRoot, entry.name)
    try {
      if (statSync(path).mtimeMs >= cutoff) continue
      // A daemon still running from this fixture polls the stop file and exits on its own.
      const queueDir = join(path, 'orchestration', 'queue')
      if (existsSync(queueDir)) writeFileSync(join(queueDir, 'stop'), '')
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      removed += 1
    } catch {
      // A directory still held by a live process is left for a later run.
    }
  }
  return removed
}
