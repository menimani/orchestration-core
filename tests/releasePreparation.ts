import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchPaths } from '../src/paths.ts'

/**
 * The issue numbers a cleanup command has prepared for release but not yet published.
 * Production never reads this file back: reconciliation only renames it into the
 * release intent, so tests inspect it directly to observe the boundary in between.
 */
export function releasePreparationForTask(paths: OrchPaths, taskId: string): number[] {
  const file = join(paths.queueDir, 'issue-release-preparation', taskId)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line !== '').map(Number)
}
