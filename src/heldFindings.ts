import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

/**
 * Documentation findings held until the cycle's other work has merged. The file lives
 * beside the backlog so a daemon restart resumes from it, and run cleanup clears it.
 */
export const heldFindingsFileName = 'held-documentation.txt'

export interface HeldFinding {
  /** The depth the finding would have been queued at. */
  depth: number
  /** The task whose final message reported the finding. */
  parentTaskId: string
  finding: string
}

function heldFindingsFile(paths: OrchPaths): string {
  return join(paths.queueDir, heldFindingsFileName)
}

/** The held findings in the order they were held, one record per line. */
export function readHeldFindings(paths: OrchPaths): HeldFinding[] {
  const file = heldFindingsFile(paths)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line !== '').map((line) => {
    const match = /^(\d+)\t([^\t]+)\t(.+)$/.exec(line)
    if (match === null) {
      throw new Error(`Malformed held finding record in ${file}; repair or remove it`)
    }
    return { depth: Number(match[1]), parentTaskId: match[2]!, finding: match[3]! }
  })
}

export function writeHeldFindings(paths: OrchPaths, findings: readonly HeldFinding[]): void {
  const file = heldFindingsFile(paths)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(
      temporary,
      findings.map(({ depth, parentTaskId, finding }) => `${depth}\t${parentTaskId}\t${finding}\n`).join(''),
      { flag: 'wx' },
    )
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}
