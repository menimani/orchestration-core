import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Forge, ForgeIssue } from './adapters/forge.ts'
import {
  descSlug, existingTaskIdForDesc, forgetTaskId, newTaskId, recordTaskIdForDesc, taskIdForDesc,
} from './ids.ts'
import type { OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'
import {
  DelegatedTaskMutationError, enqueueTask, newTaskSpec, specFile, type EnqueueResult,
} from './tasks.ts'
import { frameUntrustedText } from './templates.ts'

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
export const LABEL_UNTRUSTED_AUTHOR = 'loop:untrusted-author'
const LIFECYCLE_LABELS = [
  LABEL_READY, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_MERGE_FAILED,
] as const
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000

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
  const issues = await forge.listClosedIssues(LABEL_FINDING)
  await Promise.all(issues.flatMap((issue) => LIFECYCLE_LABELS
    .filter((label) => issue.labels.includes(label))
    .map((label) => forge.removeLabel(issue.number, label))))
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

const FINDING_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'be', 'for', 'from', 'in', 'is', 'must', 'of', 'on', 'should',
  'that', 'the', 'these', 'this', 'those', 'to', 'was', 'were', 'with',
])
const FINDING_TERM_ALIASES = new Map([
  ['collapsed', 'collapse'], ['collapsing', 'collapse'],
  ['deleted', 'delete'], ['deleting', 'delete'],
  ['removed', 'remove'], ['removing', 'remove'],
])
const FINDING_ORDER_TERMS = new Set([
  'above', 'after', 'before', 'below', 'between', 'earlier', 'follow', 'later', 'next',
  'precede', 'prior', 'then',
])

function findingParts(description: string): { tag: string | undefined; path: string | undefined } {
  return {
    tag: /^\[([A-Z]+)\]/.exec(description)?.[1]?.toLowerCase(),
    path: description.match(/[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/)?.[0],
  }
}

/**
 * Keep the nouns and actions that distinguish a finding while discarding prose-only
 * variation. Sorting makes non-relational word order immaterial; repeated terms and
 * the neighbors of explicit ordering words remain significant. The deliberately small
 * stemming rules cover plural nouns and common past-tense rewrites without treating
 * synonyms as equal.
 */
function normalizedFindingText(description: string, tag?: string, path?: string): string {
  let text = description.toLowerCase()
  if (tag !== undefined) text = text.replace(new RegExp(`^\\[${tag}\\]`, 'i'), ' ')
  if (path !== undefined) text = text.replace(path.toLowerCase(), ' ')
  text = text
    .replace(/\b(?:issue|commit)\s*#?\s*(?:[0-9a-f]{7,40}|\d+)\b/gi, ' ')
    .replace(/#\d+\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')

  const terms = text.trim().split(/\s+/).flatMap((word) => {
    if (word === '' || FINDING_STOP_WORDS.has(word)) return []
    const alias = FINDING_TERM_ALIASES.get(word)
    if (alias !== undefined) return [alias]
    if (word.endsWith('ies') && word.length > 4) return [`${word.slice(0, -3)}y`]
    if (word.endsWith('s') && !/(ss|us|is|news)$/.test(word) && word.length > 3) {
      return [word.slice(0, -1)]
    }
    return [word]
  })
  const bag = [...terms].sort().join(' ')
  const order = terms.flatMap((term, index) => FINDING_ORDER_TERMS.has(term)
    ? [`${terms[index - 1] ?? '^'}>${term}>${terms[index + 1] ?? '$'}`]
    : [])
  return order.length === 0 ? bag : `${bag}|${order.join('|')}`
}

function legacyFingerprintOf(description: string): string | undefined {
  const { tag, path } = findingParts(description)
  return tag !== undefined && path !== undefined ? `${tag}:${path}` : undefined
}

function legacyFingerprintFor(fingerprint: string): string | undefined {
  const match = /^([a-z]+:.+):[0-9a-f]{16}$/.exec(fingerprint)
  return match?.[1]
}

function preGranularityTextFingerprintOf(description: string): string {
  return `text:${createHash('sha256').update(description).digest('hex').slice(0, 16)}`
}

/**
 * Advisory identifiers retain their original durable identity. Other findings use
 * tag + first path + a digest of normalized finding terms, so separate requirements
 * in one file remain separate while capitalization, punctuation, grammatical filler,
 * non-relational word order, plural/past-tense wording, and issue/commit references do
 * not matter.
 */
export function fingerprintOf(description: string): string {
  const advisory = description.toUpperCase().match(/GHSA(-[0-9A-Z]{4}){3}|CVE-\d{4}-\d{4,}/)
  if (advisory !== null) return `advisory:${advisory[0]}`
  const { tag, path } = findingParts(description)
  const normalized = normalizedFindingText(description, tag, path)
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  if (tag !== undefined && path !== undefined) return `${tag}:${path}:${digest}`
  return `text:${digest}`
}

export function buildIssueBody(
  description: string,
  parentTaskId: string,
  effort?: string,
  fingerprints: string[] = [fingerprintOf(description)],
  inspect = false,
  depth?: number,
): string {
  return [
    ...[...new Set(fingerprints)].map((fingerprint) => `Fingerprint: ${fingerprint}`),
    `Parent: ${parentTaskId}`,
    ...(depth !== undefined ? [`Depth: ${depth}`] : []),
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
  depth: number | undefined
  requirement: string
}

export function parseIssueBody(body: string): ParsedIssue | undefined {
  const lines = body.split(/\r?\n/)
  const fingerprints = lines.filter((line) => line.startsWith('Fingerprint: '))
    .map((line) => line.slice('Fingerprint: '.length))
  const fingerprint = fingerprints[0]
  const effort = lines.find((line) => line.startsWith('Effort: '))?.slice('Effort: '.length)
  const inspect = lines.includes('Inspect: true')
  const depthText = lines.find((line) => line.startsWith('Depth: '))?.slice('Depth: '.length)
  const depth = depthText !== undefined && /^\d+$/.test(depthText) ? Number(depthText) : undefined
  const requirementStart = lines.indexOf('## Requirement')
  if (fingerprint === undefined || requirementStart === -1) return undefined
  const requirementLines = lines.slice(requirementStart + 1)
  while (requirementLines.at(-1)?.trim() === '') requirementLines.pop()
  if (requirementLines.at(-1)?.startsWith('Heartbeat: ') === true) requirementLines.pop()
  const requirement = requirementLines.join('\n').trim()
  if (requirement === '') return undefined
  return { fingerprint, fingerprints, effort, inspect, depth, requirement }
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
  const legacyFingerprint = legacyFingerprintFor(fingerprint)
  const recorded = ledger.filter((entry) => entry.fingerprint === fingerprint)
  const hasLegacyEntry = legacyFingerprint !== undefined
    && ledger.some((entry) => entry.fingerprint === legacyFingerprint)
  if (recorded.length === 1 && recorded[0]?.issueNumber === issueNumber && !hasLegacyEntry) return
  const otherFingerprints = ledger.filter((entry) => entry.fingerprint !== fingerprint
    && entry.fingerprint !== legacyFingerprint)
  writeFingerprintLedger(paths, [...otherFingerprints, { fingerprint, issueNumber }])
}

function issueFingerprints(issue: ForgeIssue): string[] {
  const parsed = parseIssueBody(issue.body)
  if (parsed === undefined) return []
  const requirementLines = parsed.requirement.split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, ''))
  return parsed.fingerprints.map((fingerprint) => {
    if (isAdvisoryFingerprint(fingerprint)
      || legacyFingerprintFor(fingerprint) !== undefined) return fingerprint

    // Pre-granularity issue bodies retain their old value on the forge. Interpret
    // that value through the requirement text so dedup remains continuous, then let
    // ledger migration replace the corresponding old local entry.
    const matchingLine = requirementLines.find((line) => fingerprint.startsWith('text:')
      ? preGranularityTextFingerprintOf(line) === fingerprint
      : legacyFingerprintOf(line) === fingerprint)
    if (matchingLine !== undefined) return fingerprintOf(matchingLine)
    if (fingerprint.startsWith('text:')) {
      return preGranularityTextFingerprintOf(parsed.requirement) === fingerprint
        ? fingerprintOf(parsed.requirement)
        : fingerprint
    }
    return legacyFingerprintOf(parsed.requirement) === fingerprint
      ? fingerprintOf(parsed.requirement)
      : fingerprint
  })
}

function migrateFingerprintLedgerForIssue(paths: OrchPaths, issue: ForgeIssue): void {
  const stored = parseIssueBody(issue.body)?.fingerprints ?? []
  const effective = issueFingerprints(issue)
  const replacements = stored.flatMap((fingerprint, index) => {
    const replacement = effective[index]
    return replacement !== undefined && replacement !== fingerprint
      ? [{ fingerprint, replacement }]
      : []
  })
  if (replacements.length === 0) return
  let ledger = fingerprintLedger(paths)
  let changed = false
  for (const { fingerprint, replacement } of replacements) {
    if (!ledger.some((entry) => entry.fingerprint === fingerprint)) continue
    ledger = ledger.filter((entry) => entry.fingerprint !== fingerprint
      && entry.fingerprint !== replacement)
    ledger.push({ fingerprint: replacement, issueNumber: issue.number })
    changed = true
  }
  if (changed) writeFingerprintLedger(paths, ledger)
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
    && !issue.labels.includes(LABEL_UNTRUSTED_AUTHOR)
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
export async function reconcileFindingFingerprints(
  forge: Forge,
  paths: OrchPaths,
  knownOpenFindings?: readonly ForgeIssue[],
): Promise<void> {
  let openFindings = [...(knownOpenFindings ?? await forge.listOpenIssues(LABEL_FINDING))]
  const closedIssueNumbers = new Set<number>()
  for (const issue of openFindings) migrateFingerprintLedgerForIssue(paths, issue)
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
    const survivor = await reconcileOpenFindings(
      forge, paths, fingerprints, undefined, issues,
      (issueNumber) => closedIssueNumbers.add(issueNumber),
    )
    if (survivor !== undefined) {
      for (const fingerprint of fingerprints) recordFingerprint(paths, fingerprint, survivor)
    }
  }

  // Exact-set reconciliation cannot see a review issue carrying {A, B} and a racing
  // scan issue carrying {A}. Prefer claimed work, then the broadest ready issue, and
  // close a ready issue only when every one of its constituents is already covered.
  // Partially overlapping issues stay open so their unmatched findings are not lost.
  openFindings = knownOpenFindings === undefined
    ? await forge.listOpenIssues(LABEL_FINDING)
    : openFindings.filter((issue) => !closedIssueNumbers.has(issue.number))
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
          await closeDuplicate(
            forge, issue.number, coveredBy[0] as number,
            (issueNumber) => closedIssueNumbers.add(issueNumber),
          )
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
      // An issue whose fix already merged must not suppress a newly observed finding.
      // Advisory identifiers are deliberately durable because the same advisory
      // recurs with different prose.
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
  migrateFingerprintLedgerForIssue(paths, existing)
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
  depth?: number,
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
    body: buildIssueBody(description, parentTaskId, effort, fingerprints, false, depth),
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

/** Remove the local files that make a released issue resolve to the failed task id. */
export function dropClaimedTaskMaterialization(paths: OrchPaths, taskId: string): void {
  rmSync(specFile(paths, taskId), { force: true })
  rmSync(issueMapFile(paths, taskId), { force: true })
  rmSync(join(paths.queueDir, 'effort', taskId), { force: true })
  rmSync(join(paths.queueDir, 'inspect', taskId), { force: true })
  rmSync(join(paths.queueDir, 'heartbeat', taskId), { force: true })
  forgetTaskId(paths, taskId)
}

/** Return a startup claim to the shared queue before another worker can be blocked by it. */
export async function releaseIssueClaim(
  forge: Forge,
  issueNumber: number,
  assignee: string,
): Promise<void> {
  await withIssueCoordination(forge, issueNumber, async () => {
    await forge.addLabel(issueNumber, LABEL_READY)
    await forge.removeLabel(issueNumber, LABEL_IN_PROGRESS)
    await forge.unassignIssue(issueNumber, assignee)
  })
}

export interface IssuePromotion {
  taskId: string
  issueNumber: number
  mergeCommit: string
  runBranch: string
  commentConfirmed?: boolean
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
  const file = promotionFile(paths, issueNumber)
  const temporaryFile = join(promotionDir(paths), `.${issueNumber}.${process.pid}.tmp`)
  const existing = issuePromotionForIssue(paths, issueNumber)
  const commentConfirmed = existing?.taskId === taskId
    && existing.mergeCommit === mergeCommit
    && existing.runBranch === runBranch
    && existing.commentConfirmed === true
  try {
    writeFileSync(temporaryFile, `${JSON.stringify({
      taskId, issueNumber, mergeCommit, runBranch,
      ...(commentConfirmed ? { commentConfirmed: true } : {}),
    })}\n`)
    renameSync(temporaryFile, file)
  } finally {
    rmSync(temporaryFile, { force: true })
  }
  return issueNumber
}

/** Persist that the exact merge marker is visible on the forge. */
export function confirmIssuePromotion(paths: OrchPaths, issueNumber: number): void {
  const promotion = issuePromotionForIssue(paths, issueNumber)
  if (promotion === undefined || promotion.commentConfirmed === true) return
  const temporaryFile = join(promotionDir(paths), `.${issueNumber}.${process.pid}.tmp`)
  try {
    writeFileSync(temporaryFile, `${JSON.stringify({
      ...promotion, commentConfirmed: true,
    })}\n`)
    renameSync(temporaryFile, promotionFile(paths, issueNumber))
  } finally {
    rmSync(temporaryFile, { force: true })
  }
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
  = {
    outcome: 'claimed'
    taskId: string
    issueNumber: number
    enqueue: EnqueueResult
    pendingMerge: boolean
  }
    | { outcome: 'lost-race'; issueNumber: number }
    | { outcome: 'untrusted-author'; issueNumber: number; author: string }
    | { outcome: 'unparseable'; issueNumber: number; reason: string }

async function releasePartialClaim(forge: Forge, issueNumber: number, me: string): Promise<void> {
  // Release assignment first: ready issues with an assignee are invisible to both
  // claim polling and stale-lease reaping. The remaining mutations restore the
  // ordinary ready state even when the failed request took effect remotely.
  await forge.unassignIssue(issueNumber, me)
  const current = await forge.getIssue(issueNumber)
  if (current.state !== 'open') return
  // Add ready before removing in-progress so another label failure still leaves
  // the issue visible to stale-lease reconciliation.
  if (!current.labels.includes(LABEL_READY)) {
    await forge.addLabel(issueNumber, LABEL_READY)
  }
  if (current.labels.includes(LABEL_IN_PROGRESS)) {
    await forge.removeLabel(issueNumber, LABEL_IN_PROGRESS)
  }
}

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
    if (!current.author.hasWriteAccess) {
      if (!current.labels.includes(LABEL_UNTRUSTED_AUTHOR)) {
        await forge.addLabel(issue.number, LABEL_UNTRUSTED_AUTHOR)
      }
      return {
        outcome: 'untrusted-author',
        issueNumber: issue.number,
        author: current.author.login,
      }
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
    try {
      await forge.addLabel(issue.number, LABEL_IN_PROGRESS)
      await forge.removeLabel(issue.number, LABEL_READY)
    } catch (error) {
      try {
        await releasePartialClaim(forge, issue.number, me)
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Claim mutation and compensation both failed for issue #${issue.number}`,
        )
      }
      throw error
    }

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
      // Quarantine a finding whose body lost its structure. Merge-failed is the existing
      // terminal queue state: unlike in-progress it is not a lease that stale reaping
      // may return to the claim path. Keep the assignment and body for inspection.
      const reason = `Issue #${issue.number} has no parseable requirement. Restore its generated body, remove ${LABEL_MERGE_FAILED}, add ${LABEL_READY}, unassign the worker, and restart the loop.`
      await forge.addLabel(issue.number, LABEL_MERGE_FAILED)
      await forge.commentIssue(issue.number, reason)
      await forge.removeLabel(issue.number, LABEL_IN_PROGRESS)
      return { outcome: 'unparseable', issueNumber: issue.number, reason }
    }

    try {
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
        appendRequirements(taskId, frameUntrustedText(parsed.requirement))
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
      const enqueue = enqueueTask(paths, taskId, parsed.depth ?? 1)
      return {
        outcome: 'claimed',
        taskId,
        issueNumber: issue.number,
        enqueue,
        pendingMerge: enqueue.outcome === 'already-processed' && enqueue.status === 'completed',
      }
    } catch (error) {
      try {
        await releasePartialClaim(forge, issue.number, me)
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Claim materialization and compensation both failed for issue #${issue.number}`,
        )
      }
      throw error
    }
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
  knownOpenFindings?: readonly ForgeIssue[],
  hasMergeMarker: (issue: ForgeIssue) => Promise<boolean> = async (issue) =>
    (await forge.listIssueComments(issue.number)).some((comment) =>
      comment.author.hasWriteAccess && /^MERGED: /.test(comment.body)),
): Promise<number[]> {
  const reaped: number[] = []
  const openIssues = knownOpenFindings ?? await forge.listOpenIssues(LABEL_IN_PROGRESS)
  for (const issue of openIssues.filter((candidate) =>
    candidate.labels.includes(LABEL_IN_PROGRESS)
      && !candidate.labels.includes(LABEL_MERGE_FAILED))) {
    if (locallyRunningIssues.has(issue.number)) continue
    const ageMs = now.getTime() - new Date(issue.updatedAt).getTime()
    if (ageMs < leaseHours * 3600 * 1000) continue
    const promotion = issuePromotionForIssue(paths, issue.number)
    if (promotion !== undefined) {
      if (promotion.commentConfirmed !== true) {
        await commentOnIssueMerge(
          forge, issue.number, promotion.taskId, promotion.mergeCommit, promotion.runBranch,
        )
        confirmIssuePromotion(paths, issue.number)
      }
      continue
    }
    if (await hasMergeMarker(issue)) {
      continue
    }

    // The listing is only a candidate snapshot. A heartbeat, quarantine, or new
    // assignment may land while promotion metadata and comments are checked, so
    // re-read every part of the lease immediately before changing it.
    const current = await forge.getIssue(issue.number)
    const currentAgeMs = now.getTime() - new Date(current.updatedAt).getTime()
    if (current.state !== 'open'
      || !current.labels.includes(LABEL_IN_PROGRESS)
      || current.labels.includes(LABEL_MERGE_FAILED)
      || currentAgeMs < leaseHours * 3600 * 1000
      || current.assignees.length !== issue.assignees.length
      || current.assignees.some((assignee) => !issue.assignees.includes(assignee))) {
      continue
    }
    for (const assignee of current.assignees) {
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
  await forge.ensureLabel(
    LABEL_UNTRUSTED_AUTHOR,
    'Finding authored by an account without repository write access; inspect manually',
  )
}
