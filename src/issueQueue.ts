import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Forge, ForgeIssue } from './adapters/forge.ts'
import { taskIdForDesc } from './ids.ts'
import type { OrchPaths } from './paths.ts'
import { enqueueTask, newTaskSpec, specFile, type EnqueueResult } from './tasks.ts'

// The issue queue: scan findings become forge issues, workers claim them, and the
// merge that lands a fix closes its issue through the promotion PR. This is the
// shared-backlog layer for team operation — the local backlog stays the
// materialization buffer, and the single serial merger is untouched. Everything here
// is reached only when ISSUE_QUEUE_ENABLED=true.

export const LABEL_FINDING = 'loop:finding'
export const LABEL_READY = 'loop:ready'
export const LABEL_IN_PROGRESS = 'loop:in-progress'

/**
 * A scan words the same finding differently every cycle, so text cannot be the
 * identity. What survives rewording: an advisory identifier when one is named, else
 * the finding's tag plus the first path it names. Only when neither exists does the
 * text itself (hashed) become the identity, with whole-line semantics — the same
 * limit the decision dedup accepts.
 */
export function fingerprintOf(description: string): string {
  const advisory = description.toUpperCase().match(/GHSA(-[0-9A-Z]{4}){3}|CVE-\d{4}-\d{4,}/)
  if (advisory !== null) return `advisory:${advisory[0]}`
  const tag = /^\[([A-Z]+)\]/.exec(description)?.[1]?.toLowerCase()
  const path = description.match(/[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/)?.[0]
  if (tag !== undefined && path !== undefined) return `${tag}:${path}`
  return `text:${createHash('sha256').update(description).digest('hex').slice(0, 16)}`
}

export function buildIssueBody(description: string, parentTaskId: string, effort?: string): string {
  return [
    `Fingerprint: ${fingerprintOf(description)}`,
    `Parent: ${parentTaskId}`,
    ...(effort !== undefined ? [`Effort: ${effort}`] : []),
    '',
    '## Requirement',
    '',
    description,
    '',
  ].join('\n')
}

export interface ParsedIssue {
  fingerprint: string
  effort: string | undefined
  requirement: string
}

export function parseIssueBody(body: string): ParsedIssue | undefined {
  const lines = body.split(/\r?\n/)
  const fingerprint = lines.find((line) => line.startsWith('Fingerprint: '))?.slice('Fingerprint: '.length)
  const effort = lines.find((line) => line.startsWith('Effort: '))?.slice('Effort: '.length)
  const requirementStart = lines.indexOf('## Requirement')
  if (fingerprint === undefined || requirementStart === -1) return undefined
  const requirement = lines.slice(requirementStart + 1).join('\n').trim()
  if (requirement === '') return undefined
  return { fingerprint, effort, requirement }
}

export type PublishResult
  = { outcome: 'created'; issueNumber: number }
    | { outcome: 'duplicate'; issueNumber: number }

function fingerprintLedgerFile(paths: OrchPaths): string {
  return join(paths.queueDir, 'issue-fingerprints')
}

function fingerprintLedger(paths: OrchPaths): Array<{ fingerprint: string; issueNumber: number }> {
  const file = fingerprintLedgerFile(paths)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+) (\d+)$/.exec(line)
    return match === null ? [] : [{ fingerprint: match[1]!, issueNumber: Number(match[2]) }]
  })
}

function writeFingerprintLedger(
  paths: OrchPaths,
  entries: Array<{ fingerprint: string; issueNumber: number }>,
): void {
  writeFileSync(fingerprintLedgerFile(paths), entries.map((entry) =>
    `${entry.fingerprint} ${entry.issueNumber}\n`).join(''))
}

/**
 * File a finding as a ready issue unless an open issue already carries its
 * fingerprint. The check reads open findings only: a closed issue's fix already
 * landed, and a finding that genuinely resurfaces deserves a fresh issue.
 */
export async function publishFinding(
  forge: Forge,
  paths: OrchPaths,
  description: string,
  parentTaskId: string,
  effort?: string,
): Promise<PublishResult> {
  const fingerprint = fingerprintOf(description)
  const ledger = fingerprintLedger(paths)
  const recorded = ledger.find((entry) => entry.fingerprint === fingerprint)
  if (recorded !== undefined) {
    try {
      const issue = await forge.getIssue(recorded.issueNumber)
      if (issue.state === 'open') {
        return { outcome: 'duplicate', issueNumber: recorded.issueNumber }
      }
    } catch {
      // A missing issue is stale in the same way as a closed one.
    }
    writeFingerprintLedger(paths, ledger.filter((entry) => entry !== recorded))
  }
  const existing = (await forge.listOpenIssues(LABEL_FINDING))
    .find((issue) => issue.body.includes(`Fingerprint: ${fingerprint}`))
  if (existing !== undefined) {
    return { outcome: 'duplicate', issueNumber: existing.number }
  }
  const title = description.length > 90 ? `${description.slice(0, 87)}...` : description
  const issueNumber = await forge.createIssue({
    title,
    body: buildIssueBody(description, parentTaskId, effort),
    labels: [LABEL_FINDING, LABEL_READY],
  })
  appendFileSync(fingerprintLedgerFile(paths), `${fingerprint} ${issueNumber}\n`)
  return { outcome: 'created', issueNumber }
}

function issueMapFile(paths: OrchPaths, taskId: string): string {
  return join(paths.queueDir, 'issue-map', taskId)
}

export function recordIssueForTask(paths: OrchPaths, taskId: string, issueNumber: number): void {
  mkdirSync(join(paths.queueDir, 'issue-map'), { recursive: true })
  writeFileSync(issueMapFile(paths, taskId), `${issueNumber}\n`)
}

export function issueNumberForTask(paths: OrchPaths, taskId: string): number | undefined {
  const file = issueMapFile(paths, taskId)
  if (!existsSync(file)) return undefined
  const raw = readFileSync(file, 'utf8').trim()
  return /^\d+$/.test(raw) ? Number(raw) : undefined
}

export type ClaimResult
  = { outcome: 'claimed'; taskId: string; issueNumber: number; enqueue: EnqueueResult }
    | { outcome: 'lost-race'; issueNumber: number }
    | { outcome: 'unparseable'; issueNumber: number }

/**
 * Claim one ready issue and materialize it as a local task. Assignment is the
 * exclusivity primitive; because a forge allows several assignees, a simultaneous
 * claim is settled deterministically — the lexicographically first login wins and
 * every loser removes itself — so both sides compute the same verdict without a lock.
 */
export async function claimIssue(
  forge: Forge,
  paths: OrchPaths,
  issue: ForgeIssue,
  me: string,
  appendRequirements: (taskId: string, requirement: string) => void,
): Promise<ClaimResult> {
  await forge.assignIssue(issue.number, me)
  const after = await forge.getIssue(issue.number)
  const winner = [...after.assignees].sort()[0]
  if (winner !== me) {
    await forge.unassignIssue(issue.number, me)
    return { outcome: 'lost-race', issueNumber: issue.number }
  }
  await forge.addLabel(issue.number, LABEL_IN_PROGRESS)
  await forge.removeLabel(issue.number, LABEL_READY)

  const parsed = parseIssueBody(after.body)
  if (parsed === undefined) {
    // A finding whose body lost its structure cannot become a task; leave it claimed
    // so it does not bounce between workers, and let a person look.
    return { outcome: 'unparseable', issueNumber: issue.number }
  }

  const taskId = taskIdForDesc(paths, 'auto', parsed.requirement)
  if (!existsSync(specFile(paths, taskId))) {
    newTaskSpec(paths, taskId)
    appendRequirements(taskId, parsed.requirement)
  }
  if (parsed.effort !== undefined && ['minimal', 'low', 'medium', 'high'].includes(parsed.effort)) {
    mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'effort', taskId), `${parsed.effort}\n`)
  }
  recordIssueForTask(paths, taskId, issue.number)
  return { outcome: 'claimed', taskId, issueNumber: issue.number, enqueue: enqueueTask(paths, taskId, 1) }
}

/**
 * Return leases whose holder went quiet: in-progress issues not updated for the lease
 * window go back to ready, unassigned. A crashed worker leaves no other trace — on a
 * single machine a leftover worktree is visible, across machines only this is.
 */
export async function reapStaleLeases(
  forge: Forge,
  leaseHours: number,
  now: Date,
): Promise<number[]> {
  const reaped: number[] = []
  for (const issue of await forge.listOpenIssues(LABEL_IN_PROGRESS)) {
    const ageMs = now.getTime() - new Date(issue.updatedAt).getTime()
    if (ageMs < leaseHours * 3600 * 1000) continue
    for (const assignee of issue.assignees) {
      await forge.unassignIssue(issue.number, assignee)
    }
    await forge.addLabel(issue.number, LABEL_READY)
    await forge.removeLabel(issue.number, LABEL_IN_PROGRESS)
    reaped.push(issue.number)
  }
  return reaped
}

/** The labels the queue relies on; called once at loop startup in issue mode. */
export async function ensureQueueLabels(forge: Forge): Promise<void> {
  await forge.ensureLabel(LABEL_FINDING, 'Filed by the improvement loop from a scan or review finding')
  await forge.ensureLabel(LABEL_READY, 'Unclaimed loop work: a worker may claim it by self-assigning')
  await forge.ensureLabel(LABEL_IN_PROGRESS, 'Claimed loop work; the assignee holds the lease')
}
