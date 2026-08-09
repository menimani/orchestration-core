import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

// Task ids are `YYYYMMDD_HHMMSS_nnn_<name>`: a directory listing sorts
// chronologically and age is visible in the name itself. `nnn` is a per-day
// sequence kept in queue/task-seq.txt as `<day> <seq>`.

function timestamp(now: Date): { full: string; day: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return { full: `${day}_${time}`, day }
}

export function newTaskId(paths: OrchPaths, taskName: string, now: Date = new Date()): string {
  const { full, day } = timestamp(now)
  const seqFile = join(paths.queueDir, 'task-seq.txt')
  let seq = 0
  if (existsSync(seqFile)) {
    // A carriage return read into the sequence once made it compare equal to nothing;
    // strip whitespace wholesale so the file's line endings can never matter.
    const [prevDay, prevSeq] = readFileSync(seqFile, 'utf8').trim().split(/\s+/)
    if (prevDay === day && prevSeq !== undefined && /^\d+$/.test(prevSeq)) {
      seq = Number(prevSeq)
    }
  }
  seq += 1
  writeFileSync(seqFile, `${day} ${seq}\n`)
  return `${full}_${String(seq).padStart(3, '0')}_${taskName}`
}

/** The run-local id used in loop.log; the full id remains the on-disk identity. */
export function shortTaskId(taskId: string): string {
  const match = /^\d{8}_\d{6}_(\d{3})_(ci-fix|[^-]+)(?:-|$)/.exec(taskId)
  return match === null ? taskId : `${match[1]}_${match[2]}`
}

export function descSlug(description: string): string {
  return description
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30)
}

// The description-to-id index: the same finding reported by two parallel scans, or the
// same decision delegated twice, resolves to one task rather than two. An entry whose
// spec is gone is stale and mints a fresh id.
//
// The bash implementation hashed with POSIX cksum; this uses sha256. The index carries
// no state across implementations — every entry is validated against its spec file and
// a miss mints a fresh id — so the algorithm only has to be stable within one
// implementation, and the cutover happens between runs when the queue is empty.
function descIndexFile(paths: OrchPaths, origin: string, description: string): string {
  const hash = createHash('sha256').update(description).digest('hex').slice(0, 8)
  const indexDir = join(paths.queueDir, 'desc-index')
  mkdirSync(indexDir, { recursive: true })
  return join(indexDir, `${origin}-${hash}`)
}

export function existingTaskIdForDesc(
  paths: OrchPaths,
  origin: string,
  description: string,
): string | undefined {
  const indexFile = descIndexFile(paths, origin, description)
  if (existsSync(indexFile)) {
    const id = readFileSync(indexFile, 'utf8').replace(/[\s\r\n]/g, '')
    if (id !== '' && existsSync(join(paths.tasksDir, `${id}.md`))) {
      return id
    }
  }
  return undefined
}

export function recordTaskIdForDesc(
  paths: OrchPaths,
  origin: string,
  description: string,
  taskId: string,
): void {
  writeFileSync(descIndexFile(paths, origin, description), `${taskId}\n`)
}

export function taskIdForDesc(paths: OrchPaths, origin: string, description: string): string {
  const existing = existingTaskIdForDesc(paths, origin, description)
  if (existing !== undefined) return existing
  const id = newTaskId(paths, `${origin}-${descSlug(description)}`)
  recordTaskIdForDesc(paths, origin, description, id)
  return id
}
