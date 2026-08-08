import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logFile, statusFile, worktreeDir, type OrchPaths } from './paths.ts'

// Deletes what finished tasks leave behind: logs, status files, generated specs, and
// queue markers. What it never touches: tasks that are not merged or failed, any task
// whose worktree is still on disk (cleanup decides that fate), specs tracked by git
// (hand-written history, not loop debris), and loop.log.

export interface PruneOptions {
  days: number
  dryRun: boolean
}

export interface PruneReport {
  prunedTasks: number
  removed: string[]
  kept: string[]
}

function olderThan(file: string, days: number): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs > days * 24 * 3600 * 1000
  } catch {
    return false
  }
}

export function pruneTasks(paths: OrchPaths, options: PruneOptions): PruneReport {
  const report: PruneReport = { prunedTasks: 0, removed: [], kept: [] }

  const remove = (...files: string[]): void => {
    for (const file of files) {
      if (!existsSync(file)) continue
      if (!options.dryRun) rmSync(file, { force: true })
      report.removed.push(file)
    }
  }

  let trackedSpecs: Set<string>
  try {
    trackedSpecs = new Set(
      execFileSync('git', ['ls-files', 'orchestration/tasks/*.md'],
        { cwd: paths.repoRoot, encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/).filter((line) => line !== ''),
    )
  } catch {
    trackedSpecs = new Set()
  }

  for (const name of readdirSync(paths.statusDir)) {
    if (!name.endsWith('.json')) continue
    const file = join(paths.statusDir, name)
    if (!olderThan(file, options.days)) continue
    const taskId = name.replace(/\.json$/, '')

    let status = ''
    try {
      status = (JSON.parse(readFileSync(file, 'utf8')) as { status?: string }).status ?? ''
    } catch {
      continue
    }
    if (status !== 'merged' && status !== 'failed') continue

    if (existsSync(worktreeDir(paths, taskId))) {
      report.kept.push(`kept (worktree still on disk, run cleanup first): ${taskId}`)
      continue
    }

    const spec = join(paths.tasksDir, `${taskId}.md`)
    const specTracked = trackedSpecs.has(`orchestration/tasks/${taskId}.md`)
    remove(
      file,
      logFile(paths, taskId),
      join(paths.logsDir, `${taskId}.final`),
      join(paths.logsDir, `${taskId}.merge.log`),
      join(paths.queueDir, 'scanned', taskId),
      join(paths.queueDir, 'scanned', `${taskId}.depth`),
      join(paths.queueDir, 'effort', taskId),
      join(paths.queueDir, 'inspect', taskId),
      join(paths.queueDir, 'heartbeat', taskId),
      ...(specTracked ? [] : [spec]),
    )
    report.prunedTasks += 1
  }

  // Logs whose task has no status file at all — left by crashes or by a cleanup that
  // removed the status but not the log.
  for (const name of readdirSync(paths.logsDir)) {
    if (!name.endsWith('.log') && !name.endsWith('.final')) continue
    if (name === 'loop.log') continue
    const file = join(paths.logsDir, name)
    if (!olderThan(file, options.days)) continue
    const taskId = name.replace(/\.merge\.log$/, '').replace(/\.log$/, '').replace(/\.final$/, '')
    if (existsSync(statusFile(paths, taskId))) continue
    remove(file)
  }

  // Description-index entries whose spec is gone would only mint fresh ids anyway.
  const indexDir = join(paths.queueDir, 'desc-index')
  if (existsSync(indexDir)) {
    for (const name of readdirSync(indexDir)) {
      const file = join(indexDir, name)
      const id = readFileSync(file, 'utf8').replace(/[\s\r\n]/g, '')
      if (id !== '' && existsSync(join(paths.tasksDir, `${id}.md`))) continue
      remove(file)
    }
  }

  return report
}
