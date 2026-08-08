import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000

const POST_CREATE_RECONCILE_DELAYS_MS = [0, 100, 250, 500] as const

// Claiming and duplicate reconciliation both make multi-step forge transitions.
// Serialize those transitions per issue so one cannot act on a snapshot taken in
// the middle of the other. The final claim read below remains necessary because a
// different orchestration process does not share this coordinator.
const issueCoordination = new WeakMap<Forge, Map<number, Promise<void>>>()

async function withIssueCoordination<T>(
  forge: Forge,
  issueNumber: number,
  action: () => Promise<T>,
): Promise<T> {
  let issueTails = issueCoordination.get(forge)
  if (issueTails === undefined) {
    issueTails = new Map()
    issueCoordination.set(forge, issueTails)
  }
  const previous = issueTails.get(issueNumber) ?? Promise.resolve()
  let release: () => void = () => {}
  const tail = new Promise<void>((resolve) => { release = resolve })
  issueTails.set(issueNumber, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (issueTails.get(issueNumber) === tail) issueTails.delete(issueNumber)
  }
}

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
  const requirementLines = lines.slice(requirementStart + 1)
  while (requirementLines.at(-1)?.trim() === '') requirementLines.pop()
  if (requirementLines.at(-1)?.startsWith('Heartbeat: ') === true) requirementLines.pop()
  const requirement = requirementLines.join('\n').trim()
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

function recordFingerprint(paths: OrchPaths, fingerprint: string, issueNumber: number): void {
  const ledger = fingerprintLedger(paths)
  const recorded = ledger.filter((entry) => entry.fingerprint === fingerprint)
  if (recorded.length === 1 && recorded[0]?.issueNumber === issueNumber) return
  const otherFingerprints = ledger.filter((entry) => entry.fingerprint !== fingerprint)
  writeFingerprintLedger(paths, [...otherFingerprints, { fingerprint, issueNumber }])
}

function issueFingerprint(issue: ForgeIssue): string | undefined {
  return parseIssueBody(issue.body)?.fingerprint
}

async function closeDuplicate(forge: Forge, issueNumber: number, survivor: number): Promise<void> {
  try {
    await forge.closeIssue(issueNumber,
      `Duplicate of #${survivor}; both issues carry the same loop finding fingerprint.`)
  } catch (error) {
    // Concurrent reconcilers can both choose the same survivor. A close that lost
    // that race is successful for our purposes; only an issue still open is an error.
    try {
      if ((await forge.getIssue(issueNumber)).state === 'closed') return
    } catch {
      // Preserve the original close failure when its result cannot be verified.
    }
    throw error
  }
}

function isClaimed(issue: ForgeIssue): boolean {
  return issue.assignees.length > 0 || issue.labels.includes(LABEL_IN_PROGRESS)
}

function isReadyToClose(issue: ForgeIssue, fingerprint: string): boolean {
  return issue.state === 'open'
    && issueFingerprint(issue) === fingerprint
    && issue.assignees.length === 0
    && issue.labels.includes(LABEL_READY)
    && !issue.labels.includes(LABEL_IN_PROGRESS)
}

function isReadyToClaim(issue: ForgeIssue): boolean {
  return issue.state === 'open'
    && issue.assignees.length === 0
    && issue.labels.includes(LABEL_READY)
    && !issue.labels.includes(LABEL_IN_PROGRESS)
}

/** Preserve claimed work; otherwise keep the oldest match and close ready duplicates. */
async function reconcileOpenFindings(
  forge: Forge,
  fingerprint: string,
  createdIssueNumber?: number,
  knownOpenFindings?: ForgeIssue[],
): Promise<number | undefined> {
  const issues = new Map((knownOpenFindings ?? await forge.listOpenIssues(LABEL_FINDING))
    .filter((issue) => issueFingerprint(issue) === fingerprint)
    .map((issue) => [issue.number, issue]))
  if (createdIssueNumber !== undefined && !issues.has(createdIssueNumber)) {
    try {
      const created = await forge.getIssue(createdIssueNumber)
      if (created.state === 'open' && issueFingerprint(created) === fingerprint) {
        issues.set(created.number, created)
      }
    } catch {
      // A concurrent close can make a just-created issue disappear from the open set.
    }
  }
  const ordered = [...issues.values()].sort((a, b) => a.number - b.number)
  const survivor = ordered.find(isClaimed)?.number ?? ordered[0]?.number
  if (survivor === undefined) return undefined
  for (const duplicate of ordered) {
    if (duplicate.number === survivor) continue
    await withIssueCoordination(forge, duplicate.number, async () => {
      // Assignment and labels may have changed since listOpenIssues returned. Re-read
      // inside the same critical section used by claims before closing.
      let current: ForgeIssue
      try {
        current = await forge.getIssue(duplicate.number)
      } catch {
        return
      }
      if (isReadyToClose(current, fingerprint)) {
        await closeDuplicate(forge, current.number, survivor)
      }
    })
  }
  return survivor
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Give eventually consistent issue listings a bounded window to expose a racing creation. */
async function reconcileCreatedFinding(
  forge: Forge,
  fingerprint: string,
  createdIssueNumber: number,
): Promise<number> {
  for (const delayMs of POST_CREATE_RECONCILE_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs)
    const survivor = await reconcileOpenFindings(forge, fingerprint, createdIssueNumber)
    if (survivor !== undefined && survivor !== createdIssueNumber) return survivor
  }
  return createdIssueNumber
}

/** Revisit forge-persisted fingerprints on every poll after listing lag has cleared. */
export async function reconcileFindingFingerprints(forge: Forge, paths: OrchPaths): Promise<void> {
  const openFindings = await forge.listOpenIssues(LABEL_FINDING)
  const byFingerprint = new Map<string, ForgeIssue[]>()
  for (const issue of openFindings) {
    const fingerprint = issueFingerprint(issue)
    if (fingerprint === undefined) continue
    const matches = byFingerprint.get(fingerprint) ?? []
    matches.push(issue)
    byFingerprint.set(fingerprint, matches)
  }
  for (const [fingerprint, issues] of byFingerprint) {
    const survivor = await reconcileOpenFindings(forge, fingerprint, undefined, issues)
    if (survivor !== undefined) recordFingerprint(paths, fingerprint, survivor)
  }
}

async function findExistingFinding(
  forge: Forge,
  paths: OrchPaths,
  fingerprint: string,
): Promise<number | undefined> {
  const ledger = fingerprintLedger(paths)
  const recorded = ledger.find((entry) => entry.fingerprint === fingerprint)
  if (recorded !== undefined) {
    let recordedIssue: ForgeIssue | undefined
    try {
      recordedIssue = await forge.getIssue(recorded.issueNumber)
    } catch {
      // A missing issue is stale in the same way as a closed one.
    }
    if (recordedIssue?.state === 'open'
      && recordedIssue.labels.includes(LABEL_FINDING)
      && issueFingerprint(recordedIssue) === fingerprint) {
      const survivor = (await reconcileOpenFindings(
        forge, fingerprint, recorded.issueNumber,
      )) ?? recorded.issueNumber
      recordFingerprint(paths, fingerprint, survivor)
      return survivor
    }
    writeFingerprintLedger(paths, ledger.filter((entry) => entry !== recorded))
  }
  const existingIssueNumber = await reconcileOpenFindings(forge, fingerprint)
  if (existingIssueNumber !== undefined) {
    recordFingerprint(paths, fingerprint, existingIssueNumber)
  }
  return existingIssueNumber
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
  const existingIssueNumber = await findExistingFinding(forge, paths, fingerprint)
  if (existingIssueNumber !== undefined) {
    return { outcome: 'duplicate', issueNumber: existingIssueNumber }
  }
  const title = description.length > 90 ? `${description.slice(0, 87)}...` : description
  const issueNumber = await forge.createIssue({
    title,
    body: buildIssueBody(description, parentTaskId, effort),
    labels: [LABEL_FINDING, LABEL_READY],
  })
  // The preflight list is not a lock, and post-create listings can lag too. Re-read
  // shared forge state over a bounded window and retain the lower issue number.
  const survivor = await reconcileCreatedFinding(forge, fingerprint, issueNumber)
  recordFingerprint(paths, fingerprint, survivor)
  return survivor === issueNumber
    ? { outcome: 'created', issueNumber }
    : { outcome: 'duplicate', issueNumber: survivor }
}

async function claimReadyIssueForDelegation(
  forge: Forge,
  issueNumber: number,
  user: string,
): Promise<void> {
  await withIssueCoordination(forge, issueNumber, async () => {
    const issue = await forge.getIssue(issueNumber)
    if (!isReadyToClaim(issue)) return
    await forge.assignIssue(issueNumber, user)
    await forge.addLabel(issueNumber, LABEL_IN_PROGRESS)
    await forge.removeLabel(issueNumber, LABEL_READY)
  })
}

/** File user-delegated work as claimed, or attach the task to its existing issue. */
export async function publishDelegatedTask(
  forge: Forge,
  paths: OrchPaths,
  description: string,
  taskId: string,
  user: string,
  effort?: string,
): Promise<PublishResult> {
  const fingerprint = fingerprintOf(description)
  const existingIssueNumber = await findExistingFinding(forge, paths, fingerprint)
  if (existingIssueNumber !== undefined) {
    await claimReadyIssueForDelegation(forge, existingIssueNumber, user)
    recordIssueForTask(paths, taskId, existingIssueNumber)
    return { outcome: 'duplicate', issueNumber: existingIssueNumber }
  }

  const title = description.length > 90 ? `${description.slice(0, 87)}...` : description
  const issueNumber = await forge.createIssue({
    title,
    body: buildIssueBody(description, taskId, effort),
    labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    assignees: [user],
  })
  const survivor = await reconcileCreatedFinding(forge, fingerprint, issueNumber)
  if (survivor !== issueNumber) {
    await closeDuplicate(forge, issueNumber, survivor)
  }
  recordFingerprint(paths, fingerprint, survivor)
  recordIssueForTask(paths, taskId, survivor)
  return survivor === issueNumber
    ? { outcome: 'created', issueNumber }
    : { outcome: 'duplicate', issueNumber: survivor }
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

function heartbeatFile(paths: OrchPaths, taskId: string): string {
  return join(paths.queueDir, 'heartbeat', taskId)
}

/** Refresh a linked running task's lease at most once per heartbeat interval. */
export async function heartbeatIssueForTask(
  forge: Forge,
  paths: OrchPaths,
  taskId: string,
  now: Date,
): Promise<boolean> {
  const issueNumber = issueNumberForTask(paths, taskId)
  if (issueNumber === undefined) return false

  const file = heartbeatFile(paths, taskId)
  if (existsSync(file)) {
    const lastHeartbeat = new Date(readFileSync(file, 'utf8').trim()).getTime()
    if (Number.isFinite(lastHeartbeat) && now.getTime() - lastHeartbeat < HEARTBEAT_INTERVAL_MS) {
      return false
    }
  }

  const timestamp = now.toISOString()
  const issue = await forge.getIssue(issueNumber)
  const heartbeat = `Heartbeat: ${timestamp}`
  const body = /^Heartbeat: .*$/m.test(issue.body)
    ? issue.body.replace(/^Heartbeat: .*$/m, heartbeat)
    : `${issue.body}${issue.body.endsWith('\n') ? '' : '\n'}${heartbeat}\n`
  await forge.updateIssueBody(issueNumber, body)
  mkdirSync(join(paths.queueDir, 'heartbeat'), { recursive: true })
  writeFileSync(file, `${timestamp}\n`)
  return true
}

export async function commentOnIssueMerge(
  forge: Forge,
  issueNumber: number,
  mergeCommit: string,
  runBranch: string,
): Promise<void> {
  await forge.commentIssue(issueNumber,
    `Merged as ${mergeCommit} into run branch ${runBranch}. This issue closes on promotion.`)
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
 * The login is the worker identity: concurrently claiming processes must use distinct
 * forge accounts because assignment cannot distinguish processes sharing an account.
 */
export async function claimIssue(
  forge: Forge,
  paths: OrchPaths,
  issue: ForgeIssue,
  me: string,
  appendRequirements: (taskId: string, requirement: string) => void,
): Promise<ClaimResult> {
  return withIssueCoordination(forge, issue.number, async () => {
    const current = await forge.getIssue(issue.number)
    if (!isReadyToClaim(current)) {
      return { outcome: 'lost-race', issueNumber: issue.number }
    }

    await forge.assignIssue(issue.number, me)
    const afterAssignment = await forge.getIssue(issue.number)
    const winner = [...afterAssignment.assignees].sort()[0]
    if (afterAssignment.state !== 'open'
      || !afterAssignment.labels.includes(LABEL_READY)
      || afterAssignment.labels.includes(LABEL_IN_PROGRESS)
      || winner !== me) {
      await forge.unassignIssue(issue.number, me)
      return { outcome: 'lost-race', issueNumber: issue.number }
    }
    await forge.addLabel(issue.number, LABEL_IN_PROGRESS)
    await forge.removeLabel(issue.number, LABEL_READY)

    // A remote reconciler can still close or relabel the issue because its process
    // does not share this coordinator. Revalidate after every claim mutation and
    // immediately before materializing local work.
    const claimed = await forge.getIssue(issue.number)
    if (claimed.state !== 'open'
      || claimed.labels.includes(LABEL_READY)
      || !claimed.labels.includes(LABEL_IN_PROGRESS)
      || [...claimed.assignees].sort()[0] !== me) {
      await forge.unassignIssue(issue.number, me)
      return { outcome: 'lost-race', issueNumber: issue.number }
    }

    const parsed = parseIssueBody(claimed.body)
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
  })
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
