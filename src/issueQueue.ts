import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { Forge, ForgeIssue } from './adapters/forge.ts'
import {
  descSlug, existingTaskIdForDesc, forgetTaskId, newTaskId, recordTaskIdForDesc, taskIdForDesc,
} from './ids.ts'
import { finalMessageFile, isReviewTaskId, type OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'
import {
  DelegatedTaskMutationError, enqueueTask, newTaskSpec, specFile, type EnqueueResult,
} from './tasks.ts'
import { frameVerifiedRequirement } from './templates.ts'

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
export const LABEL_GROUP_SINGLETON = 'loop:group-singleton'
export const QUEUE_LABELS = [
  { name: LABEL_FINDING, description: 'Filed by the improvement loop from a scan or review finding' },
  { name: LABEL_READY, description: 'Unclaimed loop work: a worker may claim it by self-assigning' },
  { name: LABEL_IN_PROGRESS, description: 'Claimed loop work; the assignee holds the lease' },
  { name: LABEL_MERGE_READY, description: 'Completed worker branch waiting for the merger' },
  { name: LABEL_MERGE_FAILED, description: 'Worker branch that the merger could not adopt' },
  {
    name: LABEL_UNTRUSTED_AUTHOR,
    description: 'Finding authored by an account without repository write access; inspect manually',
  },
  {
    name: LABEL_GROUP_SINGLETON,
    description: 'Finding released from a failed group; claim it as an individual task',
  },
] as const
const LIFECYCLE_LABELS = [
  LABEL_READY, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_MERGE_FAILED,
] as const
type LifecycleLabel = typeof LIFECYCLE_LABELS[number]
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000
export const MAX_CLAIM_GROUP_SIZE = 4

const POST_CREATE_RECONCILE_DELAYS_MS = [0, 100, 250, 500] as const

// Claiming and duplicate reconciliation both make multi-step forge transitions.
// Serialize those transitions per issue so one cannot act on a snapshot taken in
// the middle of the other. The final claim read below remains necessary because a
// different orchestration process does not share this coordinator.
const issueCoordination = new WeakMap<Forge, Map<number, Promise<void>>>()

/** A claimable or actionable issue occupies one and only one lifecycle state. */
export function issueHasExactlyLifecycleLabel(
  issue: ForgeIssue,
  expected: LifecycleLabel,
): boolean {
  return LIFECYCLE_LABELS.filter((label) => issue.labels.includes(label)).length === 1
    && issue.labels.includes(expected)
}

/** Remove queue-position labels after a direct close while preserving finding metadata. */
export async function closeIssueAndRemoveLifecycleLabels(
  forge: Forge,
  issueNumber: number,
  comment: string,
): Promise<void> {
  let issue = await forge.getIssue(issueNumber)
  if (issue.state === 'open') {
    await forge.closeIssue(issueNumber, comment)
    issue = await forge.getIssue(issueNumber)
  }
  if (issue.state !== 'closed') {
    throw new Error(`Issue #${issueNumber} is still open after closure`)
  }
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

/** The first path in a finding title is its established primary-file convention. */
export function findingPrimaryFile(title: string): string | undefined {
  return findingParts(title).path
}

/** Keep no-file findings isolated and bound every same-file claim to a reviewable size. */
export function groupReadyFindings(
  issues: readonly ForgeIssue[],
  limit = MAX_CLAIM_GROUP_SIZE,
): ForgeIssue[][] {
  const groups: ForgeIssue[][] = []
  const byFile = new Map<string, ForgeIssue[]>()
  for (const issue of issues) {
    const file = findingPrimaryFile(issue.title)
    if (file === undefined || issue.labels.includes(LABEL_GROUP_SINGLETON)) {
      groups.push([issue])
      continue
    }
    // A grouped task has one identifier, so keep scan and review origins separate even
    // when their findings name the same file.
    const parsed = parseIssueBody(issue.body, issue.number)
    const mode = parsed?.inspect === true ? 'inspect' : 'implement'
    const key = `${findingTaskOrigin(parsed?.parentTaskId)}:${mode}:${file}`
    let group = byFile.get(key)
    if (group === undefined || group.length >= limit) {
      group = []
      byFile.set(key, group)
      groups.push(group)
    }
    group.push(issue)
  }
  return groups
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
  parentTaskId: string | undefined
  effort: string | undefined
  inspect: boolean
  depth: number | undefined
  requirement: string
}

type IssueBodyParseResult
  = { parsed: ParsedIssue; problem?: never }
    | { parsed?: never; problem: string }

function inspectIssueBody(body: string, issueNumber: number): IssueBodyParseResult {
  const lines = body.split(/\r?\n/)
  const fingerprints = lines.filter((line) => line.startsWith('Fingerprint: '))
    .map((line) => line.slice('Fingerprint: '.length))
  if (fingerprints.length === 0) fingerprints.push(`issue:${issueNumber}`)
  const fingerprint = fingerprints[0]!
  const parentTaskId = lines.find((line) => line.startsWith('Parent: '))
    ?.slice('Parent: '.length)
  const effort = lines.find((line) => line.startsWith('Effort: '))?.slice('Effort: '.length)
  const inspect = lines.includes('Inspect: true')
  const depthText = lines.find((line) => line.startsWith('Depth: '))?.slice('Depth: '.length)
  const depth = depthText !== undefined && /^\d+$/.test(depthText) ? Number(depthText) : undefined
  const requirementStart = lines.indexOf('## Requirement')
  if (requirementStart === -1) {
    return { problem: 'missing `## Requirement` heading' }
  }
  const nextHeading = lines.findIndex((line, index) =>
    index > requirementStart && line.startsWith('## '))
  const requirementLines = lines.slice(
    requirementStart + 1,
    nextHeading === -1 ? undefined : nextHeading,
  )
  while (requirementLines.at(-1)?.trim() === '') requirementLines.pop()
  if (requirementLines.at(-1)?.startsWith('Heartbeat: ') === true) requirementLines.pop()
  const requirement = requirementLines.join('\n').trim()
  if (requirement === '') return { problem: 'empty requirement' }
  return {
    parsed: { fingerprint, fingerprints, parentTaskId, effort, inspect, depth, requirement },
  }
}

export function parseIssueBody(body: string, issueNumber: number): ParsedIssue | undefined {
  return inspectIssueBody(body, issueNumber).parsed
}

function findingTaskOrigin(parentTaskId: string | undefined): 'auto' | 'fix' {
  return parentTaskId !== undefined && isReviewTaskId(parentTaskId) ? 'fix' : 'auto'
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
  const parsed = parseIssueBody(issue.body, issue.number)
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
  if (!isTrustedFingerprintOwner(issue)) return
  const stored = parseIssueBody(issue.body, issue.number)?.fingerprints ?? []
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

function isTrustedFingerprintOwner(issue: ForgeIssue): boolean {
  return issue.author.hasWriteAccess && !issue.labels.includes(LABEL_UNTRUSTED_AUTHOR)
}

function isReadyToClose(issue: ForgeIssue, fingerprints: string[]): boolean {
  return issue.state === 'open'
    && isTrustedFingerprintOwner(issue)
    && hasExactFingerprints(issue, fingerprints)
    && issue.assignees.length === 0
    && issueHasExactlyLifecycleLabel(issue, LABEL_READY)
}

function isReadyToClaim(issue: ForgeIssue): boolean {
  return issue.state === 'open'
    && issue.assignees.length === 0
    && issueHasExactlyLifecycleLabel(issue, LABEL_READY)
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
    .filter((issue) => isTrustedFingerprintOwner(issue)
      && hasExactFingerprints(issue, fingerprints)
      && fingerprints.every((fingerprint) =>
        issueSuppressesFingerprint(paths, issue, fingerprint)))
    .map((issue) => [issue.number, issue]))
  if (createdIssueNumber !== undefined && !issues.has(createdIssueNumber)) {
    try {
      const created = await forge.getIssue(createdIssueNumber)
      if (created.state === 'open'
        && isTrustedFingerprintOwner(created)
        && hasExactFingerprints(created, fingerprints)) {
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
  const excludedIssueNumbers = new Set(openFindings
    .filter((issue) => !isTrustedFingerprintOwner(issue))
    .map((issue) => issue.number))
  if (excludedIssueNumbers.size > 0) {
    const ledger = fingerprintLedger(paths)
    const retained = ledger.filter((entry) => !excludedIssueNumbers.has(entry.issueNumber))
    if (retained.length !== ledger.length) writeFingerprintLedger(paths, retained)
  }
  openFindings = openFindings.filter(isTrustedFingerprintOwner)
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
    ? (await forge.listOpenIssues(LABEL_FINDING)).filter(isTrustedFingerprintOwner)
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
      // A missing issue cannot validate even a durable advisory ledger entry.
    }
    const durableClosedAdvisory = recordedIssue?.state === 'closed'
      && isAdvisoryFingerprint(fingerprint)
      && issueCompletionForIssue(paths, recordedIssue.number) !== undefined
    if (recordedIssue !== undefined
      && (recordedIssue.state === 'open' || durableClosedAdvisory)
      && isTrustedFingerprintOwner(recordedIssue)
      && recordedIssue.labels.includes(LABEL_FINDING)
      && hasIssueFingerprint(recordedIssue, fingerprint)
      // An issue whose fix already merged must not suppress a newly observed finding.
      // Advisory identifiers are deliberately durable because the same advisory
      // recurs with different prose.
      && issueSuppressesFingerprint(paths, recordedIssue, fingerprint)) {
      if (durableClosedAdvisory) return recorded.issueNumber
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
    .filter((issue) => isTrustedFingerprintOwner(issue)
      && hasIssueFingerprint(issue, fingerprint)
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
 * fingerprint. Ordinary closed findings can recur as fresh work; advisory identifiers
 * remain durable after their promoted issue closes.
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

function releaseIntentDir(paths: OrchPaths): string {
  return join(paths.queueDir, 'issue-release-intent')
}

function releasePreparationDir(paths: OrchPaths): string {
  return join(paths.queueDir, 'issue-release-preparation')
}

function releaseIntentFile(paths: OrchPaths, taskId: string): string {
  return join(releaseIntentDir(paths), taskId)
}

function releasePreparationFile(paths: OrchPaths, taskId: string): string {
  return join(releasePreparationDir(paths), taskId)
}

export function recordIssueForTask(paths: OrchPaths, taskId: string, issueNumber: number): void {
  recordIssuesForTask(paths, taskId, [issueNumber])
}

export function recordIssuesForTask(
  paths: OrchPaths,
  taskId: string,
  issueNumbers: readonly number[],
): void {
  mkdirSync(join(paths.queueDir, 'issue-map'), { recursive: true })
  writeFileSync(issueMapFile(paths, taskId), `${[...new Set(issueNumbers)].join('\n')}\n`)
}

export function issueNumbersForTask(paths: OrchPaths, taskId: string): number[] {
  const file = issueMapFile(paths, taskId)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
}

function writeIssueNumbers(file: string, issueNumbers: readonly number[]): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  const taskId = file.split(/[\\/]/).at(-1)!
  const temporaryFile = join(directory, `.${taskId}.${process.pid}.tmp`)
  try {
    writeFileSync(temporaryFile, `${[...new Set(issueNumbers)].join('\n')}\n`)
    renameSync(temporaryFile, file)
  } finally {
    rmSync(temporaryFile, { force: true })
  }
}

/** Record release work whose local cleanup is already complete. */
export function recordIssueReleaseIntent(
  paths: OrchPaths,
  taskId: string,
  issueNumbers: readonly number[],
): void {
  writeIssueNumbers(releaseIntentFile(paths, taskId), issueNumbers)
}

/** Persist cleanup release work without making it visible to daemon reconciliation. */
export function prepareIssueReleaseIntent(
  paths: OrchPaths,
  taskId: string,
  issueNumbers: readonly number[],
): void {
  writeIssueNumbers(releasePreparationFile(paths, taskId), issueNumbers)
}

/** Atomically make a prepared release visible after local cleanup completes. */
export function completeIssueReleaseIntent(paths: OrchPaths, taskId: string): void {
  mkdirSync(releaseIntentDir(paths), { recursive: true })
  renameSync(releasePreparationFile(paths, taskId), releaseIntentFile(paths, taskId))
}

export function issueReleaseIntentForTask(paths: OrchPaths, taskId: string): number[] {
  const file = releaseIntentFile(paths, taskId)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
}

export function issueReleasePreparationForTask(paths: OrchPaths, taskId: string): number[] {
  const file = releasePreparationFile(paths, taskId)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
}

/** Cancel a release preparation that did not reach completed local cleanup. */
export function removeIssueReleasePreparation(paths: OrchPaths, taskId: string): void {
  rmSync(releasePreparationFile(paths, taskId), { force: true })
}

/** Remove release work after it has reconciled successfully. */
export function removeIssueReleaseIntent(paths: OrchPaths, taskId: string): void {
  rmSync(releaseIntentFile(paths, taskId), { force: true })
}

export function issueNumberForTask(paths: OrchPaths, taskId: string): number | undefined {
  return issueNumbersForTask(paths, taskId)[0]
}

export function missingRequirementCompletionMarkers(paths: OrchPaths, taskId: string): number[] {
  const issueNumbers = issueNumbersForTask(paths, taskId)
  if (issueNumbers.length < 2) return []
  const finalFile = finalMessageFile(paths, taskId)
  if (!existsSync(finalFile)) return issueNumbers
  const markers = new Set(readFileSync(finalFile, 'utf8').split(/\r?\n/)
    .flatMap((line) => {
      const match = /^REQUIREMENT_COMPLETE: #(\d+)$/.exec(line.trim())
      return match === null ? [] : [Number(match[1])]
    }))
  return issueNumbers.filter((issueNumber) => !markers.has(issueNumber))
}

/** Remove the local files that make a released issue resolve to the failed task id. */
export function dropClaimedTaskMaterialization(
  paths: OrchPaths,
  taskId: string,
  preserveIssueMapping = false,
): void {
  const errors: unknown[] = []
  for (const file of [
    specFile(paths, taskId),
    ...(preserveIssueMapping ? [] : [issueMapFile(paths, taskId)]),
    join(paths.queueDir, 'effort', taskId),
    join(paths.queueDir, 'inspect', taskId),
    join(paths.queueDir, 'heartbeat', taskId),
  ]) {
    try {
      rmSync(file, { force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    forgetTaskId(paths, taskId)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Could not remove materialization for task ${taskId}`)
  }
}

/** Return a startup claim to the shared queue before another worker can be blocked by it. */
export async function releaseIssueClaim(
  forge: Forge,
  issueNumber: number,
  assignee: string,
): Promise<void> {
  await withIssueCoordination(forge, issueNumber, async () => {
    await forge.unassignIssue(issueNumber, assignee)
    await forge.addLabel(issueNumber, LABEL_READY)
    await forge.removeLabel(issueNumber, LABEL_IN_PROGRESS)
    const released = await forge.getIssue(issueNumber)
    if (released.state === 'open'
      && (released.assignees.length !== 0
        || !issueHasExactlyLifecycleLabel(released, LABEL_READY))) {
      throw new Error(`Issue #${issueNumber} did not reach the single ${LABEL_READY} lifecycle state`)
    }
  })
}

/** Restore any open claimed lifecycle state to an individually claimable finding. */
export async function returnIssueToReady(
  forge: Forge,
  issueNumber: number,
  keepSingleton = false,
): Promise<void> {
  await withIssueCoordination(forge, issueNumber, async () => {
    const issue = await forge.getIssue(issueNumber)
    if (issue.state !== 'open') return
    for (const assignee of issue.assignees) await forge.unassignIssue(issueNumber, assignee)
    if (keepSingleton && !issue.labels.includes(LABEL_GROUP_SINGLETON)) {
      await forge.addLabel(issueNumber, LABEL_GROUP_SINGLETON)
    }
    if (!issue.labels.includes(LABEL_READY)) await forge.addLabel(issueNumber, LABEL_READY)
    for (const label of [LABEL_MERGE_READY, LABEL_MERGE_FAILED, LABEL_IN_PROGRESS]) {
      if (issue.labels.includes(label)) await forge.removeLabel(issueNumber, label)
    }
    const released = await forge.getIssue(issueNumber)
    if (released.state === 'open'
      && (released.assignees.length !== 0
        || !issueHasExactlyLifecycleLabel(released, LABEL_READY))) {
      throw new Error(`Issue #${issueNumber} did not reach the single ${LABEL_READY} lifecycle state`)
    }
  })
}

export interface IssueReleaseFailure {
  issueNumber: number
  error: unknown
}

export class IssueReleaseReconciliationError extends AggregateError {
  readonly failures: readonly IssueReleaseFailure[]

  constructor(failures: readonly IssueReleaseFailure[]) {
    const issues = failures.map(({ issueNumber }) => `#${issueNumber}`).join(' ')
    super(
      failures.map(({ error }) => error),
      `Could not reconcile persisted issue releases for ${issues}`,
    )
    this.name = 'IssueReleaseReconciliationError'
    this.failures = failures
  }
}

/** Retry one durable cleanup release, removing the intent only after every issue verifies. */
export async function reconcileIssueReleaseIntent(
  forge: Forge,
  paths: OrchPaths,
  taskId: string,
): Promise<IssueReleaseFailure[]> {
  const issueNumbers = issueReleaseIntentForTask(paths, taskId)
  if (issueNumbers.length === 0) return []
  const keepSingleton = issueNumbers.length > 1
  const results = await Promise.allSettled(issueNumbers.map((issueNumber) =>
    returnIssueToReady(forge, issueNumber, keepSingleton)))
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [{ issueNumber: issueNumbers[index]!, error: result.reason }]
    : [])
  if (failures.length === 0) {
    dropClaimedTaskMaterialization(paths, taskId)
    removeIssueReleaseIntent(paths, taskId)
  }
  return failures
}

/** Reconcile cleanup releases left by earlier commands or interrupted daemon polls. */
export async function reconcileIssueReleaseIntents(
  forge: Forge,
  paths: OrchPaths,
): Promise<IssueReleaseFailure[]> {
  const directory = releaseIntentDir(paths)
  if (!existsSync(directory)) return []
  const failures: IssueReleaseFailure[] = []
  for (const taskId of readdirSync(directory).filter((name) => !name.startsWith('.'))) {
    failures.push(...await reconcileIssueReleaseIntent(forge, paths, taskId))
  }
  return failures
}

export interface IssuePromotion {
  taskId: string
  issueNumber: number
  mergeCommit: string
  runBranch: string
  commentConfirmed?: boolean
}

export interface IssueCompletion {
  taskId: string
  issueNumber: number
  outcome: 'merged' | 'no-change'
}

function completionDir(paths: OrchPaths): string {
  return join(paths.queueDir, 'issue-completion')
}

function completionFile(paths: OrchPaths, issueNumber: number): string {
  return join(completionDir(paths), `${issueNumber}.json`)
}

export function issueCompletionForIssue(
  paths: OrchPaths,
  issueNumber: number,
): IssueCompletion | undefined {
  const file = completionFile(paths, issueNumber)
  if (!existsSync(file)) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<IssueCompletion>
    if (typeof value.taskId !== 'string' || value.taskId === ''
      || value.issueNumber !== issueNumber
      || (value.outcome !== 'merged' && value.outcome !== 'no-change')) return undefined
    return value as IssueCompletion
  } catch {
    return undefined
  }
}

/** Persist task completion after transient promotion and task-to-issue metadata is gone. */
export function recordIssueCompletions(
  paths: OrchPaths,
  taskId: string,
  outcome: IssueCompletion['outcome'],
): number[] {
  const issueNumbers = issueNumbersForTask(paths, taskId)
  if (issueNumbers.length === 0) return []
  mkdirSync(completionDir(paths), { recursive: true })
  for (const issueNumber of issueNumbers) {
    const temporaryFile = join(completionDir(paths), `.${issueNumber}.${process.pid}.tmp`)
    try {
      writeFileSync(temporaryFile, `${JSON.stringify({ taskId, issueNumber, outcome })}\n`)
      renameSync(temporaryFile, completionFile(paths, issueNumber))
    } finally {
      rmSync(temporaryFile, { force: true })
    }
  }
  return issueNumbers
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
  return recordIssuePromotions(paths, taskId, mergeCommit, runBranch)[0]
}

export function recordIssuePromotions(
  paths: OrchPaths,
  taskId: string,
  mergeCommit: string,
  runBranch: string,
): number[] {
  const issueNumbers = issueNumbersForTask(paths, taskId)
  if (issueNumbers.length === 0) return []
  mkdirSync(promotionDir(paths), { recursive: true })
  for (const issueNumber of issueNumbers) {
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
  }
  recordIssueCompletions(paths, taskId, 'merged')
  return issueNumbers
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
    if (promotion !== undefined) {
      const taskStillPromoting = readdirSync(dir).some((candidate) => {
        const candidateNumber = /^(\d+)\.json$/.exec(candidate)?.[1]
        return candidateNumber !== undefined
          && issuePromotionForIssue(paths, Number(candidateNumber))?.taskId === promotion.taskId
      })
      if (!taskStillPromoting) rmSync(issueMapFile(paths, promotion.taskId), { force: true })
    }
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
  const issueNumbers = issueNumbersForTask(paths, taskId)
  if (issueNumbers.length === 0) return false

  const file = heartbeatFile(paths, taskId)
  if (existsSync(file)) {
    const lastHeartbeat = new Date(readFileSync(file, 'utf8').trim()).getTime()
    if (Number.isFinite(lastHeartbeat) && now.getTime() - lastHeartbeat < HEARTBEAT_INTERVAL_MS) {
      return false
    }
  }

  const timestamp = now.toISOString()
  await Promise.all(issueNumbers.map((issueNumber) =>
    forge.commentIssue(issueNumber, `Heartbeat: ${timestamp}`)))
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
    issueNumbers: number[]
    enqueue: EnqueueResult
    pendingMerge: boolean
  }
    | {
      outcome: 'already-processed'
      taskId: string
      issueNumber: number
      issueNumbers: number[]
    }
    | { outcome: 'lost-race'; issueNumber: number }
    | { outcome: 'untrusted-author'; issueNumber: number; author: string }
    | { outcome: 'unparseable'; issueNumber: number; reason: string }

async function releasePartialClaim(
  forge: Forge,
  issueNumber: number,
  me: string,
  keepSingleton = false,
): Promise<void> {
  // Release assignment first: ready issues with an assignee are invisible to both
  // claim polling and stale-lease reaping. The remaining mutations restore the
  // ordinary ready state even when the failed request took effect remotely.
  await forge.unassignIssue(issueNumber, me)
  const current = await forge.getIssue(issueNumber)
  if (current.state !== 'open') return
  if (keepSingleton && !current.labels.includes(LABEL_GROUP_SINGLETON)) {
    await forge.addLabel(issueNumber, LABEL_GROUP_SINGLETON)
  }
  // Add ready before removing in-progress so another label failure still leaves
  // the issue visible to stale-lease reconciliation.
  if (!current.labels.includes(LABEL_READY)) {
    await forge.addLabel(issueNumber, LABEL_READY)
  }
  if (current.labels.includes(LABEL_IN_PROGRESS)) {
    await forge.removeLabel(issueNumber, LABEL_IN_PROGRESS)
  }
}

async function releasePartialQuarantine(
  forge: Forge,
  issueNumber: number,
  me: string,
): Promise<void> {
  // Remove the quarantine marker first. If compensation is interrupted after this
  // point, the remaining in-progress claim is still eligible for stale-lease reaping.
  const current = await forge.getIssue(issueNumber)
  if (current.state === 'open' && current.labels.includes(LABEL_MERGE_FAILED)) {
    await forge.removeLabel(issueNumber, LABEL_MERGE_FAILED)
  }
  await releasePartialClaim(forge, issueNumber, me)
}

async function withIssueCoordinations<T>(
  forge: Forge,
  issueNumbers: readonly number[],
  action: () => Promise<T>,
): Promise<T> {
  const numbers = [...new Set(issueNumbers)].sort((a, b) => a - b)
  const lock = (index: number): Promise<T> => index === numbers.length
    ? action()
    : withIssueCoordination(forge, numbers[index]!, () => lock(index + 1))
  return lock(0)
}

type RemoteClaimResult
  = { outcome: 'claimed'; issue: ForgeIssue; parsed: ParsedIssue }
    | Exclude<ClaimResult, { outcome: 'claimed' }>

async function claimRemoteIssue(
  forge: Forge,
  issue: ForgeIssue,
  me: string,
): Promise<RemoteClaimResult> {
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
  let afterAssignment: ForgeIssue
  try {
    afterAssignment = await forge.getIssue(issue.number)
  } catch (error) {
    try {
      await forge.unassignIssue(issue.number, me)
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Claim verification and compensation both failed for issue #${issue.number}`,
      )
    }
    throw error
  }
  const winner = [...afterAssignment.assignees].sort()[0]
  if (afterAssignment.state !== 'open'
    || !issueHasExactlyLifecycleLabel(afterAssignment, LABEL_READY)
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

  const claimed = await forge.getIssue(issue.number)
  if (claimed.state !== 'open'
    || !issueHasExactlyLifecycleLabel(claimed, LABEL_IN_PROGRESS)
    || [...claimed.assignees].sort()[0] !== me) {
    await forge.unassignIssue(issue.number, me)
    return { outcome: 'lost-race', issueNumber: issue.number }
  }

  const bodyParse = inspectIssueBody(claimed.body, claimed.number)
  if (bodyParse.parsed === undefined) {
    const reason = `Issue #${issue.number} cannot be materialized: ${bodyParse.problem}. Fix the issue body, remove ${LABEL_MERGE_FAILED}, add ${LABEL_READY}, unassign the worker, and restart the loop.`
    try {
      await forge.addLabel(issue.number, LABEL_MERGE_FAILED)
      await forge.commentIssue(issue.number, reason)
      await forge.removeLabel(issue.number, LABEL_IN_PROGRESS)
    } catch (error) {
      try {
        await releasePartialQuarantine(forge, issue.number, me)
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Issue quarantine and compensation both failed for issue #${issue.number}`,
        )
      }
      throw error
    }
    return { outcome: 'unparseable', issueNumber: issue.number, reason }
  }
  return { outcome: 'claimed', issue: claimed, parsed: bodyParse.parsed }
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
  return claimIssueGroup(forge, paths, [issue], me, (taskId, requirements) => {
    appendRequirements(taskId, frameVerifiedRequirement(requirements[0]!.requirement))
  })
}

export interface ClaimedRequirement {
  issueNumber: number
  requirement: string
}

/** Claim and materialize a bounded set of findings as one task, or compensate all members. */
export async function claimIssueGroup(
  forge: Forge,
  paths: OrchPaths,
  issues: readonly ForgeIssue[],
  me: string,
  appendRequirements: (taskId: string, requirements: ClaimedRequirement[]) => void,
): Promise<ClaimResult> {
  if (issues.length === 0 || issues.length > MAX_CLAIM_GROUP_SIZE) {
    throw new Error(`A claim group must contain between 1 and ${MAX_CLAIM_GROUP_SIZE} issues.`)
  }
  return withIssueCoordinations(forge, issues.map((candidate) => candidate.number), async () => {
    const claimedIssues: Array<{ issue: ForgeIssue; parsed: ParsedIssue }> = []
    let createdTaskId: string | undefined
    try {
      for (const issue of issues) {
        const result = await claimRemoteIssue(forge, issue, me)
        if (result.outcome !== 'claimed') {
          await Promise.all(claimedIssues.map(({ issue: claimed }) =>
            releasePartialClaim(forge, claimed.number, me, issues.length > 1)))
          return result
        }
        claimedIssues.push(result)
      }

      const requirements = claimedIssues.map(({ issue: claimed, parsed }) => ({
        issueNumber: claimed.number,
        requirement: parsed.requirement,
      }))
      const description = requirements.map(({ requirement }) => requirement).join('\n\n')
      const inspectionModes = new Set(claimedIssues.map(({ parsed }) => parsed.inspect))
      if (inspectionModes.size > 1) {
        throw new Error('A claim group cannot mix inspection and implementation issues.')
      }
      const origin = claimedIssues.some(({ parsed }) =>
        findingTaskOrigin(parsed.parentTaskId) === 'fix') ? 'fix' : 'auto'
      const existing = existingTaskIdForDesc(paths, origin, description)
      const existingStatus = existing === undefined ? undefined : readStatus(paths, existing)?.status
      const terminalAdvisory = existing !== undefined
        && (existingStatus === 'merged' || existingStatus === 'no-change')
        && requirements.every(({ requirement }) =>
          fingerprintOf(requirement).startsWith('advisory:'))
      if (terminalAdvisory) {
        const issueNumbers = requirements.map(({ issueNumber }) => issueNumber)
        for (const { issue: claimed } of claimedIssues) {
          await forge.unassignIssue(claimed.number, me)
          await closeIssueAndRemoveLifecycleLabels(
            forge,
            claimed.number,
            `Duplicate advisory already processed by task ${existing} (${existingStatus}).`,
          )
        }
        return {
          outcome: 'already-processed',
          taskId: existing,
          issueNumber: issueNumbers[0]!,
          issueNumbers,
        }
      }
      const needsFreshTask = existing !== undefined
        && (existingStatus === 'merged' || existingStatus === 'no-change')
        && !requirements.every(({ requirement }) =>
          fingerprintOf(requirement).startsWith('advisory:'))
      const taskId = needsFreshTask
        ? newTaskId(paths, `${origin}-${descSlug(description)}`)
        : taskIdForDesc(paths, origin, description)
      if (needsFreshTask) recordTaskIdForDesc(paths, origin, description, taskId)
      if (!existsSync(specFile(paths, taskId))) {
        // taskIdForDesc records the description index before the specification is
        // materialized. Remember ownership before the first write so any failure,
        // including appendRequirements, can discard both pieces before the remote
        // issue becomes claimable again.
        createdTaskId = taskId
        newTaskSpec(paths, taskId)
        appendRequirements(taskId, requirements)
      }
      const effortOrder = ['minimal', 'low', 'medium', 'high']
      const selectedEffort = claimedIssues.map(({ parsed }) => parsed.effort)
        .filter((effort): effort is string => effort !== undefined && effortOrder.includes(effort))
        .sort((a, b) => effortOrder.indexOf(b) - effortOrder.indexOf(a))[0]
      if (selectedEffort !== undefined) {
        mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
        writeFileSync(join(paths.queueDir, 'effort', taskId), `${selectedEffort}\n`)
      }
      if (claimedIssues.some(({ parsed }) => parsed.inspect)) {
        mkdirSync(join(paths.queueDir, 'inspect'), { recursive: true })
        writeFileSync(join(paths.queueDir, 'inspect', taskId), '')
      }
      const issueNumbers = requirements.map(({ issueNumber }) => issueNumber)
      recordIssuesForTask(paths, taskId, issueNumbers)
      const depth = Math.max(...claimedIssues.map(({ parsed }) => parsed.depth ?? 1))
      const enqueue = enqueueTask(paths, taskId, depth)
      return {
        outcome: 'claimed',
        taskId,
        issueNumber: issueNumbers[0]!,
        issueNumbers,
        enqueue,
        pendingMerge: enqueue.outcome === 'already-processed' && enqueue.status === 'completed',
      }
    } catch (error) {
      const compensationErrors: unknown[] = [error]
      if (createdTaskId !== undefined) {
        try {
          dropClaimedTaskMaterialization(paths, createdTaskId)
        } catch (cleanupError) {
          compensationErrors.push(cleanupError)
        }
      }
      for (const { issue: claimed } of claimedIssues) {
        try {
          await releasePartialClaim(forge, claimed.number, me, issues.length > 1)
        } catch (releaseError) {
          compensationErrors.push(releaseError)
        }
      }
      if (compensationErrors.length > 1) {
        throw new AggregateError(compensationErrors,
          `Claim group materialization and compensation both failed for issues ${issues.map((candidate) => `#${candidate.number}`).join(', ')}`)
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
  const releaseFailures = await reconcileIssueReleaseIntents(forge, paths)
  if (releaseFailures.length > 0) {
    throw new IssueReleaseReconciliationError(releaseFailures)
  }
  const reaped: number[] = []
  const openIssues = knownOpenFindings ?? await forge.listOpenIssues(LABEL_IN_PROGRESS)
  for (const issue of openIssues.filter((candidate) =>
    candidate.labels.includes(LABEL_IN_PROGRESS)
      && (!candidate.labels.includes(LABEL_MERGE_FAILED)
        || (candidate.labels.includes(LABEL_READY) && candidate.assignees.length === 0)))) {
    if (locallyRunningIssues.has(issue.number)) continue
    // An interrupted reap has already removed every assignee. Its last mutation
    // refreshed updatedAt, but no worker remains to heartbeat it, so finish that
    // transition without making the orphan wait through another lease window.
    const partiallyReaped = issue.assignees.length === 0
    const ageMs = now.getTime() - new Date(issue.updatedAt).getTime()
    if (!partiallyReaped && ageMs < leaseHours * 3600 * 1000) continue
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
    const currentlyPartiallyReaped = current.assignees.length === 0
    const currentAgeMs = now.getTime() - new Date(current.updatedAt).getTime()
    if (current.state !== 'open'
      || !current.labels.includes(LABEL_IN_PROGRESS)
      || (current.labels.includes(LABEL_MERGE_FAILED)
        && (!current.labels.includes(LABEL_READY) || current.assignees.length !== 0))
      || (!currentlyPartiallyReaped && currentAgeMs < leaseHours * 3600 * 1000)
      || current.assignees.length !== issue.assignees.length
      || current.assignees.some((assignee) => !issue.assignees.includes(assignee))) {
      continue
    }
    await returnIssueToReady(forge, issue.number)
    reaped.push(issue.number)
  }
  await removeClosedPromotionRecords(forge, paths)
  return reaped
}

/** Create only missing queue labels; existing repository-owned metadata is untouched. */
export async function ensureQueueLabels(forge: Forge): Promise<string[]> {
  const existing = new Set(await forge.listLabels())
  const created: string[] = []
  for (const label of QUEUE_LABELS) {
    if (existing.has(label.name)) continue
    await forge.createLabel(label.name, label.description)
    existing.add(label.name)
    created.push(label.name)
  }
  return created
}
