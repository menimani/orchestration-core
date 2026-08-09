import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Forge, ForgeIssue } from './adapters/forge.ts'
import {
  descSlug, existingTaskIdForDesc, newTaskId, recordTaskIdForDesc, taskIdForDesc,
} from './ids.ts'
import type { OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'
import {
  DelegatedTaskMutationError, enqueueTask, newTaskSpec, specFile, type EnqueueResult,
} from './tasks.ts'

// The issue queue: scan findings become forge issues, workers claim them, and the
// merge that lands a fix closes its issue through the promotion PR. This is the
// shared-backlog layer for team operation — the local backlog stays the
// materialization buffer, and the single serial merger is untouched. Everything here
// is reached only when ISSUE_QUEUE_ENABLED=true.

export const LABEL_FINDING = 'loop:finding'
export const LABEL_READY = 'loop:ready'
export const LABEL_IN_PROGRESS = 'loop:in-progress'
export const LABEL_MERGE_READY = 'loop:merge-ready'
export const LABEL_MERGE_FAILED = 'loop:merge-failed'
export const LIFECYCLE_LABELS = [
  LABEL_READY, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_MERGE_FAILED,
] as const
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000

const POST_CREATE_RECONCILE_DELAYS_MS = [0, 100, 250, 500] as const

// Claiming and duplicate reconciliation both make multi-step forge transitions.
// Serialize those transitions per issue so one cannot act on a snapshot taken in
// the middle of the other. The final claim read below remains necessary because a
// different orchestration process does not share this coordinator.
const issueCoordination = new WeakMap<Forge, Map<number, Promise<void>>>()

/** Remove queue-position labels after a direct close while preserving finding metadata. */
export async function closeIssueAndRemoveLifecycleLabels(
  forge: Forge,
  issueNumber: number,
  comment: string,
): Promise<void> {
  await forge.closeIssue(issueNumber, comment)
  const issue = await forge.getIssue(issueNumber)
  await Promise.all(LIFECYCLE_LABELS
    .filter((label) => issue.labels.includes(label))
    .map((label) => forge.removeLabel(issueNumber, label)))
}

/** Strip stale queue-position labels from issues closed by the forge. */
export async function reconcileClosedIssueLifecycleLabels(forge: Forge): Promise<void> {
  const issuesByLabel = await Promise.all(LIFECYCLE_LABELS.map(async (label) => ({
    label,
    issues: await forge.listClosedIssues(label),
  })))
  await Promise.all(issuesByLabel.flatMap(({ label, issues }) =>
    issues.map((issue) => forge.removeLabel(issue.number, label))))
}

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

export function buildIssueBody(
  description: string,
  parentTaskId: string,
  effort?: string,
  fingerprints: string[] = [fingerprintOf(description)],
  inspect = false,
): string {
  return [
    ...[...new Set(fingerprints)].map((fingerprint) => `Fingerprint: ${fingerprint}`),
    `Parent: ${parentTaskId}`,
    ...(effort !== undefined ? [`Effort: ${effort}`] : []),
    ...(inspect ? ['Inspect: true'] : []),
    '',
    '## Requirement',
    '',
    description,
    '',
  ].join('\n')
}

export interface ParsedIssue {
  fingerprint: string
  fingerprints: string[]
  effort: string | undefined
  inspect: boolean
  requirement: string
}

export function parseIssueBody(body: string): ParsedIssue | undefined {
  const lines = body.split(/\r?\n/)
  const fingerprints = lines.filter((line) => line.startsWith('Fingerprint: '))
    .map((line) => line.slice('Fingerprint: '.length))
  const fingerprint = fingerprints[0]
  const effort = lines.find((line) => line.startsWith('Effort: '))?.slice('Effort: '.length)
  const inspect = lines.includes('Inspect: true')
  const requirementStart = lines.indexOf('## Requirement')
  if (fingerprint === undefined || requirementStart === -1) return undefined
  const requirementLines = lines.slice(requirementStart + 1)
  while (requirementLines.at(-1)?.trim() === '') requirementLines.pop()
  if (requirementLines.at(-1)?.startsWith('Heartbeat: ') === true) requirementLines.pop()
  const requirement = requirementLines.join('\n').trim()
  if (requirement === '') return undefined
  return { fingerprint, fingerprints, effort, inspect, requirement }
}

export type PublishResult
  = { outcome: 'created'; issueNumber: number }
    | { outcome: 'duplicate'; issueNumber: number }

export type DelegatedPublishResult = PublishResult & { materialize: false }

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

function issueFingerprints(issue: ForgeIssue): string[] {
  return parseIssueBody(issue.body)?.fingerprints ?? []
}

function hasIssueFingerprint(issue: ForgeIssue, fingerprint: string): boolean {
  return issueFingerprints(issue).includes(fingerprint)
}

function hasExactFingerprints(issue: ForgeIssue, fingerprints: string[]): boolean {
  const expected = [...new Set(fingerprints)].sort()
  const actual = [...new Set(issueFingerprints(issue))].sort()
  return actual.length === expected.length
    && actual.every((fingerprint, index) => fingerprint === expected[index])
}

function isAdvisoryFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith('advisory:')
}

function issueHasMergedFix(paths: OrchPaths, issue: ForgeIssue): boolean {
  return issuePromotionForIssue(paths, issue.number) !== undefined
}

/** Merged fixes are finished work; advisory identities alone remain durable across merges. */
function issueSuppressesFingerprint(
  paths: OrchPaths,
  issue: ForgeIssue,
  fingerprint: string,
): boolean {
  return isAdvisoryFingerprint(fingerprint)
    || !issueHasMergedFix(paths, issue)
}

async function closeDuplicate(
  forge: Forge,
  issueNumber: number,
  survivor: number,
  onMutation?: (issueNumber: number) => void,
): Promise<void> {
  try {
    onMutation?.(issueNumber)
    await closeIssueAndRemoveLifecycleLabels(forge, issueNumber,
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

function isReadyToClose(issue: ForgeIssue, fingerprints: string[]): boolean {
  return issue.state === 'open'
    && hasExactFingerprints(issue, fingerprints)
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
  paths: OrchPaths,
  fingerprints: string[],
  createdIssueNumber?: number,
  knownOpenFindings?: ForgeIssue[],
  onMutation?: (issueNumber: number) => void,
): Promise<number | undefined> {
  const issues = new Map((knownOpenFindings ?? await forge.listOpenIssues(LABEL_FINDING))
    .filter((issue) => hasExactFingerprints(issue, fingerprints)
      && fingerprints.every((fingerprint) =>
        issueSuppressesFingerprint(paths, issue, fingerprint)))
    .map((issue) => [issue.number, issue]))
  if (createdIssueNumber !== undefined && !issues.has(createdIssueNumber)) {
    try {
      const created = await forge.getIssue(createdIssueNumber)
      if (created.state === 'open' && hasExactFingerprints(created, fingerprints)) {
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
      if (isReadyToClose(current, fingerprints)) {
        await closeDuplicate(forge, current.number, survivor, onMutation)
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
  paths: OrchPaths,
  fingerprints: string[],
  createdIssueNumber: number,
): Promise<number> {
  for (const delayMs of POST_CREATE_RECONCILE_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs)
    const survivor = await reconcileOpenFindings(forge, paths, fingerprints, createdIssueNumber)
    if (survivor !== undefined && survivor !== createdIssueNumber) return survivor
  }
  return createdIssueNumber
}

/** Revisit forge-persisted fingerprints on every poll after listing lag has cleared. */
export async function reconcileFindingFingerprints(forge: Forge, paths: OrchPaths): Promise<void> {
  let openFindings = await forge.listOpenIssues(LABEL_FINDING)
  const byFingerprintSet = new Map<string, { fingerprints: string[]; issues: ForgeIssue[] }>()
  for (const issue of openFindings) {
    const fingerprints = issueFingerprints(issue)
    if (fingerprints.length === 0) continue
    const key = JSON.stringify([...new Set(fingerprints)].sort())
    const group = byFingerprintSet.get(key) ?? { fingerprints, issues: [] }
    group.issues.push(issue)
    byFingerprintSet.set(key, group)
  }
  for (const { fingerprints, issues } of byFingerprintSet.values()) {
    const survivor = await reconcileOpenFindings(forge, paths, fingerprints, undefined, issues)
    if (survivor !== undefined) {
      for (const fingerprint of fingerprints) recordFingerprint(paths, fingerprint, survivor)
    }
  }

  // Exact-set reconciliation cannot see a review issue carrying {A, B} and a racing
  // scan issue carrying {A}. Prefer claimed work, then the broadest ready issue, and
  // close a ready issue only when every one of its constituents is already covered.
  // Partially overlapping issues stay open so their unmatched findings are not lost.
  openFindings = await forge.listOpenIssues(LABEL_FINDING)
  const ordered = openFindings
    .filter((issue) => issueFingerprints(issue).length > 0)
    .sort((a, b) => Number(isClaimed(b)) - Number(isClaimed(a))
      || issueFingerprints(b).length - issueFingerprints(a).length
      || a.number - b.number)
  const owners = new Map<string, number>()
  for (const issue of ordered) {
    const fingerprints = [...new Set(issueFingerprints(issue))]
      .filter((fingerprint) => issueSuppressesFingerprint(paths, issue, fingerprint))
    if (fingerprints.length === 0) continue
    const coveredBy = fingerprints.map((fingerprint) => owners.get(fingerprint))
    if (!issueHasMergedFix(paths, issue)
      && !isClaimed(issue)
      && coveredBy.every((owner) => owner !== undefined)) {
      await withIssueCoordination(forge, issue.number, async () => {
        let current: ForgeIssue
        try {
          current = await forge.getIssue(issue.number)
        } catch {
          return
        }
        if (isReadyToClose(current, fingerprints)) {
          await closeDuplicate(forge, issue.number, coveredBy[0] as number)
        }
      })
      continue
    }
    for (const fingerprint of fingerprints) {
      if (!owners.has(fingerprint)) owners.set(fingerprint, issue.number)
    }
  }
  for (const [fingerprint, issueNumber] of owners) {
    recordFingerprint(paths, fingerprint, issueNumber)
  }
}

async function findExistingFinding(
  forge: Forge,
  paths: OrchPaths,
  fingerprint: string,
  onMutation?: (issueNumber: number) => void,
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
      && hasIssueFingerprint(recordedIssue, fingerprint)
      // An issue whose fix already merged must not suppress a new finding with the
      // same coarse fingerprint: the tag+first-path identity collapses distinct
      // defects in one file, and a review's fresh finding about new code was eaten
      // by a merged-but-unpromoted issue exactly this way. Advisory identifiers are
      // deliberately durable because the same advisory recurs with different prose.
      && issueSuppressesFingerprint(paths, recordedIssue, fingerprint)) {
      const fingerprints = issueFingerprints(recordedIssue)
      const survivor = (await reconcileOpenFindings(
        forge, paths, fingerprints, recorded.issueNumber, undefined, onMutation,
      )) ?? recorded.issueNumber
      recordFingerprint(paths, fingerprint, survivor)
      return survivor
    }
    writeFingerprintLedger(paths, ledger.filter((entry) => entry !== recorded))
  }
  const matching = (await forge.listOpenIssues(LABEL_FINDING))
    .filter((issue) => hasIssueFingerprint(issue, fingerprint)
      && issueSuppressesFingerprint(paths, issue, fingerprint))
    .sort((a, b) => Number(isClaimed(b)) - Number(isClaimed(a)) || a.number - b.number)
  const existing = matching[0]
  if (existing === undefined) return undefined
  const existingIssueNumber = (await reconcileOpenFindings(
    forge, paths, issueFingerprints(existing), existing.number, undefined, onMutation,
  )) ?? existing.number
  recordFingerprint(paths, fingerprint, existingIssueNumber)
  return existingIssueNumber
}

export async function unresolvedFindings(
  forge: Forge,
  paths: OrchPaths,
  findings: string[],
): Promise<{ unresolved: string[]; duplicates: Array<{ finding: string; issueNumber: number }> }> {
  const unresolved: string[] = []
  const duplicates: Array<{ finding: string; issueNumber: number }> = []
  const seen = new Set<string>()
  for (const finding of findings) {
    const fingerprint = fingerprintOf(finding)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    const issueNumber = await findExistingFinding(forge, paths, fingerprint)
    if (issueNumber === undefined) unresolved.push(finding)
    else duplicates.push({ finding, issueNumber })
  }
  return { unresolved, duplicates }
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
  titleText = description,
  fingerprintDescriptions?: string[],
): Promise<PublishResult> {
  const fingerprints = [...new Set(
    (fingerprintDescriptions ?? [description]).map((finding) => fingerprintOf(finding)),
  )]
  if (fingerprintDescriptions === undefined) {
    const existingIssueNumber = await findExistingFinding(forge, paths, fingerprints[0] as string)
    if (existingIssueNumber !== undefined) {
      return { outcome: 'duplicate', issueNumber: existingIssueNumber }
    }
  }
  const title = titleText.length > 90 ? `${titleText.slice(0, 87)}...` : titleText
  const issueNumber = await forge.createIssue({
    title,
    body: buildIssueBody(description, parentTaskId, effort, fingerprints),
    labels: [LABEL_FINDING, LABEL_READY],
  })
  // The preflight list is not a lock, and post-create listings can lag too. Re-read
  // shared forge state over a bounded window and retain the lower issue number.
  const survivor = await reconcileCreatedFinding(forge, paths, fingerprints, issueNumber)
  for (const fingerprint of fingerprints) recordFingerprint(paths, fingerprint, survivor)
  return survivor === issueNumber
    ? { outcome: 'created', issueNumber }
    : { outcome: 'duplicate', issueNumber: survivor }
}

/** Publish delegated work for the daemon to claim and materialize. */
export async function publishDelegatedTask(
  forge: Forge,
  paths: OrchPaths,
  description: string,
  taskId: string,
  effort?: string,
  inspect = false,
): Promise<DelegatedPublishResult> {
  const fingerprint = fingerprintOf(description)
  let reconciliationMutation: number | undefined
  let existingIssueNumber: number | undefined
  try {
    existingIssueNumber = await findExistingFinding(
      forge, paths, fingerprint, (issueNumber) => { reconciliationMutation = issueNumber },
    )
  } catch (error) {
    if (reconciliationMutation !== undefined) {
      throw new DelegatedTaskMutationError(error, reconciliationMutation)
    }
    throw error
  }
  if (existingIssueNumber !== undefined) {
    return { outcome: 'duplicate', issueNumber: existingIssueNumber, materialize: false }
  }

  const title = description.length > 90 ? `${description.slice(0, 87)}...` : description
  let issueNumber: number
  try {
    issueNumber = await forge.createIssue({
      title,
      body: buildIssueBody(description, taskId, effort, undefined, inspect),
      labels: [LABEL_FINDING, LABEL_READY],
    })
  } catch (error) {
    // The request may have reached the forge even when its response did not. With no
    // issue number available, reconciliation is impossible and materialization aborts.
    throw new DelegatedTaskMutationError(error)
  }
  try {
    const survivor = await reconcileCreatedFinding(forge, paths, [fingerprint], issueNumber)
    if (survivor !== issueNumber) {
      await closeDuplicate(forge, issueNumber, survivor)
      recordFingerprint(paths, fingerprint, survivor)
      return { outcome: 'duplicate', issueNumber: survivor, materialize: false }
    }
    recordFingerprint(paths, fingerprint, issueNumber)
    return { outcome: 'created', issueNumber, materialize: false }
  } catch (error) {
    throw error instanceof DelegatedTaskMutationError
      ? error
      : new DelegatedTaskMutationError(error, issueNumber)
  }
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

export interface IssuePromotion {
  taskId: string
  issueNumber: number
  mergeCommit: string
  runBranch: string
}

function promotionDir(paths: OrchPaths): string {
  return join(paths.queueDir, 'issue-promotion')
}

function promotionFile(paths: OrchPaths, issueNumber: number): string {
  return join(promotionDir(paths), `${issueNumber}.json`)
}

export function issuePromotionForIssue(
  paths: OrchPaths,
  issueNumber: number,
): IssuePromotion | undefined {
  const file = promotionFile(paths, issueNumber)
  if (!existsSync(file)) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<IssuePromotion>
    if (typeof value.taskId !== 'string'
      || value.issueNumber !== issueNumber
      || typeof value.mergeCommit !== 'string'
      || value.mergeCommit === ''
      || typeof value.runBranch !== 'string'
      || value.runBranch === '') return undefined
    return value as IssuePromotion
  } catch {
    return undefined
  }
}

/** Persist the merge identity independently of task status until promotion closes its issue. */
export function recordIssuePromotion(
  paths: OrchPaths,
  taskId: string,
  mergeCommit: string,
  runBranch: string,
): number | undefined {
  const issueNumber = issueNumberForTask(paths, taskId)
  if (issueNumber === undefined) return undefined
  mkdirSync(promotionDir(paths), { recursive: true })
  writeFileSync(promotionFile(paths, issueNumber), `${JSON.stringify({
    taskId, issueNumber, mergeCommit, runBranch,
  })}\n`)
  return issueNumber
}

async function removeClosedPromotionRecords(forge: Forge, paths: OrchPaths): Promise<void> {
  const dir = promotionDir(paths)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(name)
    if (match === null) continue
    const issueNumber = Number(match[1])
    let issue: ForgeIssue
    try {
      issue = await forge.getIssue(issueNumber)
    } catch {
      continue
    }
    if (issue.state !== 'closed') continue
    const promotion = issuePromotionForIssue(paths, issueNumber)
    rmSync(join(dir, name), { force: true })
    if (promotion !== undefined) rmSync(issueMapFile(paths, promotion.taskId), { force: true })
  }
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
  await forge.commentIssue(issueNumber, `Heartbeat: ${timestamp}`)
  mkdirSync(join(paths.queueDir, 'heartbeat'), { recursive: true })
  writeFileSync(file, `${timestamp}\n`)
  return true
}

export async function commentOnIssueMerge(
  forge: Forge,
  issueNumber: number,
  taskId: string,
  mergeCommit: string,
  runBranch: string,
): Promise<void> {
  await forge.commentIssue(issueNumber, issueMergeComment(taskId, mergeCommit, runBranch))
}

export function issueMergeComment(taskId: string, mergeCommit: string, runBranch: string): string {
  return `MERGED: ${taskId}\nMerged as ${mergeCommit} into run branch ${runBranch}. This issue closes on promotion.`
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

    const existing = existingTaskIdForDesc(paths, 'auto', parsed.requirement)
    const needsFreshTask = existing !== undefined
      && readStatus(paths, existing)?.status === 'merged'
      && !fingerprintOf(parsed.requirement).startsWith('advisory:')
    const taskId = needsFreshTask
      ? newTaskId(paths, `auto-${descSlug(parsed.requirement)}`)
      : taskIdForDesc(paths, 'auto', parsed.requirement)
    if (needsFreshTask) recordTaskIdForDesc(paths, 'auto', parsed.requirement, taskId)
    if (!existsSync(specFile(paths, taskId))) {
      newTaskSpec(paths, taskId)
      appendRequirements(taskId, parsed.requirement)
    }
    if (parsed.effort !== undefined && ['minimal', 'low', 'medium', 'high'].includes(parsed.effort)) {
      mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
      writeFileSync(join(paths.queueDir, 'effort', taskId), `${parsed.effort}\n`)
    }
    if (parsed.inspect) {
      mkdirSync(join(paths.queueDir, 'inspect'), { recursive: true })
      writeFileSync(join(paths.queueDir, 'inspect', taskId), '')
    }
    recordIssueForTask(paths, taskId, issue.number)
    return { outcome: 'claimed', taskId, issueNumber: issue.number, enqueue: enqueueTask(paths, taskId, 1) }
  })
}

/**
 * Return leases whose holder went quiet: in-progress issues not updated for the lease
 * window go back to ready, unassigned. A locally merged task instead refreshes its
 * issue until promotion closes it; a forge-visible merge marker protects the same
 * issue in other checkouts. A crashed worker leaves no other trace — on a single
 * machine a leftover worktree is visible, across machines only this is.
 */
export async function reapStaleLeases(
  forge: Forge,
  paths: OrchPaths,
  leaseHours: number,
  now: Date,
  locallyRunningIssues: ReadonlySet<number> = new Set(),
): Promise<number[]> {
  const reaped: number[] = []
  for (const issue of await forge.listOpenIssues(LABEL_IN_PROGRESS)) {
    if (locallyRunningIssues.has(issue.number)) continue
    const ageMs = now.getTime() - new Date(issue.updatedAt).getTime()
    if (ageMs < leaseHours * 3600 * 1000) continue
    const promotion = issuePromotionForIssue(paths, issue.number)
    if (promotion !== undefined) {
      await commentOnIssueMerge(
        forge, issue.number, promotion.taskId, promotion.mergeCommit, promotion.runBranch,
      )
      continue
    }
    if ((await forge.listIssueComments(issue.number)).some((comment) => /^MERGED: /.test(comment))) {
      continue
    }
    for (const assignee of issue.assignees) {
      await forge.unassignIssue(issue.number, assignee)
    }
    await forge.addLabel(issue.number, LABEL_READY)
    await forge.removeLabel(issue.number, LABEL_IN_PROGRESS)
    reaped.push(issue.number)
  }
  await removeClosedPromotionRecords(forge, paths)
  return reaped
}

/** The labels the queue relies on; called once at loop startup in issue mode. */
export async function ensureQueueLabels(forge: Forge): Promise<void> {
  await forge.ensureLabel(LABEL_FINDING, 'Filed by the improvement loop from a scan or review finding')
  await forge.ensureLabel(LABEL_READY, 'Unclaimed loop work: a worker may claim it by self-assigning')
  await forge.ensureLabel(LABEL_IN_PROGRESS, 'Claimed loop work; the assignee holds the lease')
  await forge.ensureLabel(LABEL_MERGE_READY, 'Completed worker branch waiting for the merger')
  await forge.ensureLabel(LABEL_MERGE_FAILED, 'Worker branch that the merger could not adopt')
}
