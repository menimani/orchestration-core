import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeIssue } from '../src/adapters/forge.ts'
import {
  buildIssueBody, claimIssue, claimIssueGroup, closeIssueAndRemoveLifecycleLabels,
  commentOnIssueMerge, fingerprintOf, groupReadyFindings, heartbeatIssueForTask,
  issueNumberForTask, issueNumbersForTask, issuePromotionForIssue,
  missingRequirementCompletionMarkers, parseIssueBody,
  publishDelegatedTask, publishFinding, reapStaleLeases,
  reconcileClosedIssueLifecycleLabels, reconcileFindingFingerprints, recordIssueForTask,
  recordIssuesForTask, recordIssuePromotion, recordIssuePromotions, LABEL_FINDING,
  LABEL_GROUP_SINGLETON, LABEL_IN_PROGRESS, LABEL_MERGE_FAILED,
  LABEL_MERGE_READY, LABEL_READY, LABEL_UNTRUSTED_AUTHOR,
} from '../src/issueQueue.ts'
import { existingTaskIdForDesc } from '../src/ids.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { recordTaskProcess } from '../src/processRegistry.ts'
import { specFile } from '../src/tasks.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { stubProject } from './stubProject.ts'

let repoRoot: string
let paths: OrchPaths
let forge: FakeForge

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-issues-'))
  paths = orchPaths(repoRoot)
  forge = makeFakeForge()
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('fingerprintOf', () => {
  it('identifies an advisory by its identifier, however the sentence around it reads', () => {
    expect(fingerprintOf('Dependabot alert #1 (high, GHSA-qwww-vcr4-c8h2) affects react-router'))
      .toBe('advisory:GHSA-QWWW-VCR4-C8H2')
    expect(fingerprintOf('the fix for cve-2026-22030 crosses a major version'))
      .toBe('advisory:CVE-2026-22030')
  })

  it('distinguishes ordinary findings by normalized text after tag and first path', () => {
    const closeButtons = fingerprintOf(
      '[LAYOUT] Remove the close buttons from `src/frontend/src/pages/CalendarPage.tsx`',
    )
    const addButtons = fingerprintOf(
      '[LAYOUT] Collapse the add buttons in `src/frontend/src/pages/CalendarPage.tsx`',
    )
    expect(closeButtons).toMatch(/^layout:src\/frontend\/src\/pages\/CalendarPage\.tsx:[0-9a-f]{16}$/)
    expect(closeButtons).not.toBe(addButtons)
  })

  it('collapses grammatical rewording, punctuation, and issue or commit references', () => {
    const first = fingerprintOf(
      '[LAYOUT] `src/frontend/styles.css`: Remove empty .live-event-form rules (#448).',
    )
    const second = fingerprintOf(
      '[LAYOUT] The empty rules for .live-event-form should be removed in '
      + '`src/frontend/styles.css`; issue 921, commit deadbeef.',
    )
    expect(first).toBe(second)
  })

  it('distinguishes inverse ordering relationships and repeated terms', () => {
    const fooBeforeBar = fingerprintOf('[BUG] `src/order.ts` requires foo before bar')
    const barBeforeFoo = fingerprintOf('[BUG] `src/order.ts` requires bar before foo')
    const repeatedFoo = fingerprintOf('[BUG] `src/order.ts` requires foo foo before bar')

    expect(fooBeforeBar).not.toBe(barBeforeFoo)
    expect(fooBeforeBar).not.toBe(repeatedFoo)
  })

  it('falls back to normalized hashed text', () => {
    const a = fingerprintOf('adopt the new expense model or keep the current one')
    const b = fingerprintOf('adopt the new expense model or keep the current one')
    const c = fingerprintOf('drop the legacy artist link or migrate it')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('text:')).toBe(true)
  })
})

describe('ready finding groups', () => {
  async function finding(title: string): Promise<ForgeIssue> {
    const number = await forge.createIssue({ title, body: '', labels: [LABEL_FINDING, LABEL_READY] })
    return forge.getIssue(number)
  }

  it('groups matching primary files in capped batches and leaves no-file titles single', async () => {
    const sameFile = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      finding(`[BUG] \`src/shared.ts\` finding ${index + 1}`)))
    const noFile = await finding('[BUG] finding without a path')
    const otherFile = await finding('[TEST] `src/other.ts` lacks coverage')

    expect(groupReadyFindings([...sameFile, noFile, otherFile]).map((group) =>
      group.map((issue) => issue.number))).toEqual([
      sameFile.slice(0, 4).map((issue) => issue.number),
      sameFile.slice(4).map((issue) => issue.number),
      [noFile.number],
      [otherFile.number],
    ])
  })

  it('does not regroup same-file findings released from a failed group', async () => {
    const first = await finding('[BUG] `src/shared.ts` first retry')
    const second = await finding('[TEST] `src/shared.ts` second retry')
    first.labels.push(LABEL_GROUP_SINGLETON)
    second.labels.push(LABEL_GROUP_SINGLETON)

    expect(groupReadyFindings([first, second]).map((group) =>
      group.map((issue) => issue.number))).toEqual([[first.number], [second.number]])
  })

  it('keeps scan and review findings for the same file in separate tasks', async () => {
    const scan = await forge.createIssue({
      title: '[BUG] `src/shared.ts` scan finding',
      body: buildIssueBody('[BUG] `src/shared.ts` scan finding', '20260808_000000_001_scan'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const review = await forge.createIssue({
      title: '[TEST] `src/shared.ts` review finding',
      body: buildIssueBody(
        '[TEST] `src/shared.ts` review finding', '20260808_000000_002_review-c1',
      ),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(groupReadyFindings([
      await forge.getIssue(scan), await forge.getIssue(review),
    ]).map((group) => group.map((issue) => issue.number))).toEqual([[scan], [review]])
  })

  it('keeps inspection and implementation findings for the same file separate', async () => {
    const implementation = await forge.createIssue({
      title: '[BUG] `src/shared.ts` implementation finding',
      body: buildIssueBody(
        '[BUG] `src/shared.ts` implementation finding', '20260808_000000_001_scan',
      ),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const inspection = await forge.createIssue({
      title: '[TEST] `src/shared.ts` inspection finding',
      body: buildIssueBody(
        '[TEST] `src/shared.ts` inspection finding', '20260808_000000_001_scan',
        undefined, undefined, true,
      ),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(groupReadyFindings([
      await forge.getIssue(implementation), await forge.getIssue(inspection),
    ]).map((group) => group.map((issue) => issue.number)))
      .toEqual([[implementation], [inspection]])
  })
})

describe('closed issue lifecycle labels', () => {
  it('removes the matching lifecycle label from a closed issue and keeps loop:finding', async () => {
    const issueNumber = await forge.createIssue({
      title: 'closed work', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    const issue = forge.issues.get(issueNumber)
    if (issue === undefined) throw new Error('expected issue')
    issue.state = 'closed'
    const removed: Array<[number, string]> = []
    const removeLabel = forge.removeLabel.bind(forge)
    forge.removeLabel = async (number, label) => {
      removed.push([number, label])
      await removeLabel(number, label)
    }

    await reconcileClosedIssueLifecycleLabels(forge)

    expect(removed).toEqual([[issueNumber, LABEL_IN_PROGRESS]])
    expect((await forge.getIssue(issueNumber)).labels).toEqual([LABEL_FINDING])
  })

  it('does not touch an open issue carrying lifecycle labels', async () => {
    const issueNumber = await forge.createIssue({
      title: 'open work', body: '',
      labels: [LABEL_FINDING, LABEL_READY, LABEL_MERGE_READY, LABEL_MERGE_FAILED],
    })

    await reconcileClosedIssueLifecycleLabels(forge)

    expect((await forge.getIssue(issueNumber)).labels)
      .toEqual([LABEL_FINDING, LABEL_READY, LABEL_MERGE_READY, LABEL_MERGE_FAILED])
  })

  it('strips lifecycle labels when the orchestration closes an issue directly', async () => {
    const issueNumber = await forge.createIssue({
      title: 'inspection', body: '',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_MERGE_READY],
    })

    await closeIssueAndRemoveLifecycleLabels(forge, issueNumber, 'Inspection completed.')

    const issue = await forge.getIssue(issueNumber)
    expect(issue.state).toBe('closed')
    expect(issue.labels).toEqual([LABEL_FINDING])
  })
})

describe('issue body round-trip', () => {
  it('parses what it builds', () => {
    const body = buildIssueBody(
      '[BUG] `src/x/y.ts` does the wrong thing', 'parent-task', 'high', undefined, false, 2,
    )
    const parsed = parseIssueBody(body, 42)
    expect(parsed?.fingerprint).toBe(fingerprintOf('[BUG] `src/x/y.ts` does the wrong thing'))
    expect(parsed?.parentTaskId).toBe('parent-task')
    expect(parsed?.effort).toBe('high')
    expect(parsed?.inspect).toBe(false)
    expect(parsed?.depth).toBe(2)
    expect(parsed?.requirement).toBe('[BUG] `src/x/y.ts` does the wrong thing')
  })

  it('derives an issue-specific fingerprint for a hand-written body', () => {
    expect(parseIssueBody('## Requirement\n\nFix the hand-written issue.\n', 42))
      .toMatchObject({ fingerprint: 'issue:42', fingerprints: ['issue:42'] })
    expect(parseIssueBody('## Requirement\n\nFix the hand-written issue.\n', 43)?.fingerprint)
      .toBe('issue:43')
  })

  it('keeps explicit fingerprints instead of deriving one', () => {
    expect(parseIssueBody([
      'Fingerprint: first',
      'Fingerprint: second',
      '',
      '## Requirement',
      '',
      'Fix the scan finding.',
    ].join('\n'), 42)?.fingerprints).toEqual(['first', 'second'])
  })

  it('ends the requirement at the next second-level heading and trims a heartbeat', () => {
    expect(parseIssueBody([
      '## Requirement',
      '',
      'Fix the issue.',
      '',
      'Heartbeat: 2026-08-12T00:00:00Z',
      '',
      '## Reporter',
      '',
      'Context for people.',
    ].join('\n'), 42)?.requirement).toBe('Fix the issue.')
  })

  it('refuses a body without a requirement heading', () => {
    expect(parseIssueBody('just prose, no fields', 42)).toBeUndefined()
  })
})

describe('publishFinding', () => {
  it('reports an immediate duplicate while the remote issue list still lags', async () => {
    forge.listOpenIssues = async () => []
    const firstDescription = '[BUG] `src/a/b.ts` Remove empty .live-event-form rules'
    const secondDescription = '[BUG] The empty rules for .live-event-form should be removed in `src/a/b.ts`'
    const first = await publishFinding(forge, paths, firstDescription, 'scan-1')
    expect(first.outcome).toBe('created')
    const issue = await forge.getIssue(first.issueNumber)
    expect(issue.labels).toEqual([LABEL_FINDING, LABEL_READY])

    const second = await publishFinding(forge, paths, secondDescription, 'scan-2')
    expect(second).toEqual({ outcome: 'duplicate', issueNumber: first.issueNumber })
    expect(forge.issues.size).toBe(1)
  })

  it.each([
    ['an outsider author', false, []],
    ['the untrusted-author label', true, [LABEL_UNTRUSTED_AUTHOR]],
  ])('does not let an issue marked by %s own a fingerprint', async (
    _description, hasWriteAccess, extraLabels,
  ) => {
    const finding = '[BUG] `src/a/b.ts` breaks'
    const fingerprint = fingerprintOf(finding)
    const untrusted = await forge.createIssue({
      title: finding,
      body: buildIssueBody(finding, 'outside'),
      labels: [LABEL_FINDING, LABEL_READY, ...extraLabels],
    })
    const stored = forge.issues.get(untrusted)
    if (stored === undefined) throw new Error('expected untrusted issue')
    stored.author = { login: 'outside-user', hasWriteAccess }
    writeFileSync(join(paths.queueDir, 'issue-fingerprints'), `${fingerprint} ${untrusted}\n`)

    const result = await publishFinding(forge, paths, finding, 'trusted-scan')

    expect(result).toEqual({ outcome: 'created', issueNumber: 2 })
    expect((await forge.getIssue(untrusted)).state).toBe('open')
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprint} 2\n`)
  })

  it.each([
    ['an outsider-authored issue', false, []],
    ['an issue with the untrusted-author label', true, [LABEL_UNTRUSTED_AUTHOR]],
  ])('excludes %s from reconciliation and the fingerprint ledger', async (
    _description, hasWriteAccess, extraLabels,
  ) => {
    const finding = '[BUG] `src/a/b.ts` breaks'
    const fingerprint = fingerprintOf(finding)
    const untrusted = await forge.createIssue({
      title: finding,
      body: buildIssueBody(finding, 'outside'),
      labels: [LABEL_FINDING, LABEL_READY, ...extraLabels],
    })
    const stored = forge.issues.get(untrusted)
    if (stored === undefined) throw new Error('expected untrusted issue')
    stored.author = { login: 'outside-user', hasWriteAccess }
    const trusted = await forge.createIssue({
      title: finding,
      body: buildIssueBody(finding, 'trusted-scan'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    writeFileSync(join(paths.queueDir, 'issue-fingerprints'), `${fingerprint} ${untrusted}\n`)

    await reconcileFindingFingerprints(forge, paths)

    expect((await forge.getIssue(untrusted)).state).toBe('open')
    expect((await forge.getIssue(trusted)).state).toBe('open')
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprint} ${trusted}\n`)
  })

  it('files different requirements with the same tag and path as separate issues', async () => {
    const closeButtons = '[LAYOUT] Remove close buttons from `src/frontend/src/pages/CalendarPage.tsx`'
    const addButtons = '[LAYOUT] Collapse add buttons in `src/frontend/src/pages/CalendarPage.tsx`'

    const first = await publishFinding(forge, paths, closeButtons, 'delegate-1')
    const second = await publishFinding(forge, paths, addButtons, 'delegate-2')

    expect(first.outcome).toBe('created')
    expect(second.outcome).toBe('created')
    expect(second.issueNumber).not.toBe(first.issueNumber)
    expect(forge.issues.size).toBe(2)
  })

  it('reuses a pre-granularity issue and replaces its coarse ledger entry', async () => {
    const original = '[LAYOUT] `src/frontend/styles.css`: Remove empty .live-event-form rules.'
    const legacyFingerprint = 'layout:src/frontend/styles.css'
    const issueNumber = await forge.createIssue({
      title: original,
      body: buildIssueBody(original, 'old-scan', undefined, [legacyFingerprint]),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    writeFileSync(join(paths.queueDir, 'issue-fingerprints'), `${legacyFingerprint} ${issueNumber}\n`)

    const result = await publishFinding(
      forge, paths,
      '[LAYOUT] The empty rules for .live-event-form should be removed in `src/frontend/styles.css`.',
      'new-scan',
    )

    expect(result).toEqual({ outcome: 'duplicate', issueNumber })
    expect(forge.issues.size).toBe(1)
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprintOf(original)} ${issueNumber}\n`)
  })

  it('migrates a pre-granularity text fallback without filing a duplicate', async () => {
    const original = 'Remove empty .live-event-form rules.'
    const oldFingerprint = `text:${createHash('sha256').update(original).digest('hex').slice(0, 16)}`
    const issueNumber = await forge.createIssue({
      title: original,
      body: buildIssueBody(original, 'old-scan', undefined, [oldFingerprint]),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    writeFileSync(join(paths.queueDir, 'issue-fingerprints'), `${oldFingerprint} ${issueNumber}\n`)

    const result = await publishFinding(
      forge, paths, 'The empty .live-event-form rules should be removed.', 'new-scan',
    )

    expect(result).toEqual({ outcome: 'duplicate', issueNumber })
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprintOf(original)} ${issueNumber}\n`)
  })

  it('reconciles concurrent creations when post-creation issue lists also lag', async () => {
    const otherPaths = orchPaths(join(repoRoot, 'other-checkout'))
    const listOpenIssues = forge.listOpenIssues.bind(forge)
    const createIssue = forge.createIssue.bind(forge)
    let listCalls = 0
    let creations = 0
    let releasePreflights: () => void = () => {}
    let releaseCreations: () => void = () => {}
    const bothPreflights = new Promise<void>((resolve) => { releasePreflights = resolve })
    const bothCreations = new Promise<void>((resolve) => { releaseCreations = resolve })
    forge.listOpenIssues = async (label) => {
      const call = ++listCalls
      if (call <= 2) {
        if (call === 2) releasePreflights()
        await bothPreflights
        return []
      }
      // Each worker's first post-create read is stale even though both issues now exist.
      if (call <= 4) return []
      return listOpenIssues(label)
    }
    forge.createIssue = async (options) => {
      const issueNumber = await createIssue(options)
      if (++creations === 2) releaseCreations()
      await bothCreations
      return issueNumber
    }

    const results = await Promise.all([
      publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1'),
      publishFinding(forge, otherPaths, '[BUG] `src/a/b.ts` breaks', 'scan-2'),
    ])

    expect(results).toEqual([
      { outcome: 'created', issueNumber: 1 },
      { outcome: 'duplicate', issueNumber: 1 },
    ])
    expect((await listOpenIssues(LABEL_FINDING)).map((issue) => issue.number)).toEqual([1])
    expect((await forge.getIssue(2)).state).toBe('closed')
    expect(listCalls).toBeGreaterThanOrEqual(5)
    const fingerprint = fingerprintOf('[BUG] `src/a/b.ts` breaks')
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8')).toBe(`${fingerprint} 1\n`)
    expect(readFileSync(join(otherPaths.queueDir, 'issue-fingerprints'), 'utf8')).toBe(`${fingerprint} 1\n`)
  })

  it('reconciles concurrent creations on a later poll after the retry window expires', async () => {
    const otherPaths = orchPaths(join(repoRoot, 'other-checkout'))
    const listOpenIssues = forge.listOpenIssues.bind(forge)
    const createIssue = forge.createIssue.bind(forge)
    let listCalls = 0
    let creations = 0
    let releasePreflights: () => void = () => {}
    let releaseCreations: () => void = () => {}
    const bothPreflights = new Promise<void>((resolve) => { releasePreflights = resolve })
    const bothCreations = new Promise<void>((resolve) => { releaseCreations = resolve })
    forge.listOpenIssues = async () => {
      if (++listCalls <= 2) {
        if (listCalls === 2) releasePreflights()
        await bothPreflights
      }
      return []
    }
    forge.createIssue = async (options) => {
      const issueNumber = await createIssue(options)
      if (++creations === 2) releaseCreations()
      await bothCreations
      return issueNumber
    }

    const results = await Promise.all([
      publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1'),
      publishFinding(forge, otherPaths, '[BUG] `src/a/b.ts` breaks', 'scan-2'),
    ])
    expect(results).toEqual([
      { outcome: 'created', issueNumber: 1 },
      { outcome: 'created', issueNumber: 2 },
    ])

    forge.listOpenIssues = listOpenIssues
    await reconcileFindingFingerprints(forge, otherPaths)

    expect((await listOpenIssues(LABEL_FINDING)).map((issue) => issue.number)).toEqual([1])
    expect((await forge.getIssue(2)).state).toBe('closed')
    expect(readFileSync(join(otherPaths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprintOf('[BUG] `src/a/b.ts` breaks')} 1\n`)
  })

  it('closes an individual issue fully subsumed by a combined review issue', async () => {
    const findingA = '[BUG] `src/a.ts` breaks'
    const findingB = '[TEST] `src/b.test.ts` lacks coverage'
    const combined = await publishFinding(
      forge, paths, `1. ${findingA}\n2. ${findingB}`, 'review-1', 'high',
      'Review round fixes', [findingA, findingB],
    )
    const individual = await forge.createIssue({
      title: findingA,
      body: buildIssueBody(findingA, 'scan-1'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    await reconcileFindingFingerprints(forge, paths)

    expect((await forge.getIssue(combined.issueNumber)).state).toBe('open')
    expect((await forge.getIssue(individual)).state).toBe('closed')
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8').split(/\r?\n/))
      .toEqual(expect.arrayContaining([
        `${fingerprintOf(findingA)} ${combined.issueNumber}`,
        `${fingerprintOf(findingB)} ${combined.issueNumber}`,
      ]))
  })

  it('keeps a partially overlapping issue that carries an unmatched finding', async () => {
    const findingA = '[BUG] `src/a.ts` breaks'
    const findingB = '[BUG] `src/b.ts` breaks'
    const findingC = '[BUG] `src/c.ts` breaks'
    const first = await publishFinding(
      forge, paths, `1. ${findingA}\n2. ${findingB}`, 'review-1', 'high',
      'First review fixes', [findingA, findingB],
    )
    const second = await forge.createIssue({
      title: 'Second review fixes',
      body: buildIssueBody(
        `1. ${findingB}\n2. ${findingC}`, 'review-2', 'high',
        [fingerprintOf(findingB), fingerprintOf(findingC)],
      ),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    await reconcileFindingFingerprints(forge, paths)

    expect((await forge.getIssue(first.issueNumber)).state).toBe('open')
    expect((await forge.getIssue(second)).state).toBe('open')
  })

  it('preserves a later claimed issue and closes only the older ready duplicate', async () => {
    const description = '[BUG] `src/a/b.ts` breaks'
    const first = await publishFinding(forge, paths, description, 'scan-1')
    const claimed = await forge.createIssue({
      title: description,
      body: buildIssueBody(description, 'scan-2'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    await forge.assignIssue(claimed, 'worker-busy')

    const result = await publishFinding(forge, paths, description, 'scan-3')

    expect(result).toEqual({ outcome: 'duplicate', issueNumber: claimed })
    expect((await forge.getIssue(first.issueNumber)).state).toBe('closed')
    const claimedAfter = await forge.getIssue(claimed)
    expect(claimedAfter.state).toBe('open')
    expect(claimedAfter.assignees).toEqual(['worker-busy'])
    expect(claimedAfter.labels).toContain(LABEL_IN_PROGRESS)
  })

  it('does not let a merged-but-unpromoted issue suppress a new same-fingerprint finding', async () => {
    // Once an issue's fix has merged locally, a fresh observation is new work, not a dup.
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'review-1')
    recordIssueForTask(paths, 'task-first-fix', first.issueNumber)
    recordIssuePromotion(paths, 'task-first-fix', 'a'.repeat(40), 'chore/run-branch')

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'review-2')
    await reconcileFindingFingerprints(forge, paths)

    expect(second.outcome).toBe('created')
    expect(second.issueNumber).not.toBe(first.issueNumber)
    expect((await forge.getIssue(first.issueNumber)).state).toBe('open')
    expect((await forge.getIssue(second.issueNumber)).state).toBe('open')
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprintOf('[BUG] `src/a/b.ts` breaks')} ${second.issueNumber}\n`)
  })

  it('still suppresses a same-fingerprint finding while the first issue is in progress', async () => {
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'review-1')
    await forge.assignIssue(first.issueNumber, 'worker-busy')
    await forge.addLabel(first.issueNumber, LABEL_IN_PROGRESS)
    await forge.removeLabel(first.issueNumber, LABEL_READY)

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'review-2')

    expect(second).toEqual({ outcome: 'duplicate', issueNumber: first.issueNumber })
    expect(forge.issues.size).toBe(1)
  })

  it('keeps advisory identifier deduplication after its issue has merged', async () => {
    const first = await publishFinding(
      forge, paths, '[SECURITY] GHSA-qwww-vcr4-c8h2 affects a dependency', 'scan-1',
    )
    recordIssueForTask(paths, 'task-advisory-fix', first.issueNumber)
    recordIssuePromotion(paths, 'task-advisory-fix', 'a'.repeat(40), 'chore/run-branch')

    const second = await publishFinding(
      forge, paths, '[SECURITY] Different wording for GHSA-QWWW-VCR4-C8H2', 'scan-2',
    )
    await reconcileFindingFingerprints(forge, paths)

    expect(second).toEqual({ outcome: 'duplicate', issueNumber: first.issueNumber })
    expect(forge.issues.size).toBe(1)
    expect((await forge.getIssue(first.issueNumber)).state).toBe('open')
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`advisory:GHSA-QWWW-VCR4-C8H2 ${first.issueNumber}\n`)
  })

  it('drops a ledger entry for a closed issue and files the finding again', async () => {
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1')
    await forge.closeIssue(first.issueNumber, 'fixed')
    forge.listOpenIssues = async () => []

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-2')

    expect(second).toEqual({ outcome: 'created', issueNumber: 2 })
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprintOf('[BUG] `src/a/b.ts` breaks')} 2\n`)
  })

  it('drops a ledger entry when the open issue no longer carries its fingerprint', async () => {
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1')
    const issue = forge.issues.get(first.issueNumber)
    if (issue === undefined) throw new Error('expected the published issue')
    issue.body = buildIssueBody('[BUG] `src/other.ts` breaks', 'edited')

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-2')

    expect(second).toEqual({ outcome: 'created', issueNumber: 2 })
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprintOf('[BUG] `src/a/b.ts` breaks')} 2\n`)
  })

  it('drops a ledger entry when the open issue is no longer a finding', async () => {
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1')
    const issue = forge.issues.get(first.issueNumber)
    if (issue === undefined) throw new Error('expected the published issue')
    issue.labels = issue.labels.filter((label) => label !== LABEL_FINDING)

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-2')

    expect(second).toEqual({ outcome: 'created', issueNumber: 2 })
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`${fingerprintOf('[BUG] `src/a/b.ts` breaks')} 2\n`)
  })

  it('lets a distinct finding through', async () => {
    await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1')
    const other = await publishFinding(forge, paths, '[TEST] `src/a/b.ts` lacks coverage', 'scan-1')
    expect(other.outcome).toBe('created')
    expect(forge.issues.size).toBe(2)
  })
})

describe('claimIssue', () => {
  async function readyIssue(description: string): Promise<number> {
    const result = await publishFinding(forge, paths, description, 'scan-1', 'high')
    return result.issueNumber
  }

  const appendRequirement = (taskId: string, requirement: string): void => {
    writeFileSync(join(paths.tasksDir, `${taskId}.md`),
      readFileSync(join(paths.tasksDir, `${taskId}.md`), 'utf8') + `\n${requirement}\n`)
  }

  it('claims same-file findings into one task while preserving each requirement', async () => {
    const descriptions = [
      '[BUG] `src/a/b.ts` rejects an empty value',
      '[TEST] `src/a/b.ts` lacks the empty-value regression',
    ]
    const issueNumbers = await Promise.all(descriptions.map(readyIssue))
    const result = await claimIssueGroup(
      forge,
      paths,
      await Promise.all(issueNumbers.map((number) => forge.getIssue(number))),
      'worker-a',
      (taskId, requirements) => writeFileSync(specFile(paths, taskId),
        `${requirements.map(({ issueNumber, requirement }) =>
          `#${issueNumber}: ${requirement}`).join('\n')}\n`),
    )
    if (result.outcome !== 'claimed') throw new Error(`expected a claim, got ${result.outcome}`)

    expect(result.issueNumbers).toEqual(issueNumbers)
    expect(issueNumbersForTask(paths, result.taskId)).toEqual(issueNumbers)
    expect(readFileSync(specFile(paths, result.taskId), 'utf8')).toBe(
      `${issueNumbers.map((number, index) => `#${number}: ${descriptions[index]}`).join('\n')}\n`,
    )
    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.labels).toContain(LABEL_IN_PROGRESS)
      expect(issue.assignees).toEqual(['worker-a'])
    }

    expect(missingRequirementCompletionMarkers(paths, result.taskId)).toEqual(issueNumbers)
    writeFileSync(join(paths.logsDir, `${result.taskId}.final`),
      `REQUIREMENT_COMPLETE: #${issueNumbers[0]}\nREQUIREMENT_COMPLETE: #${issueNumbers[1]}\n`)
    expect(missingRequirementCompletionMarkers(paths, result.taskId)).toEqual([])
  })

  it('rejects a mixed inspection and implementation claim group', async () => {
    const descriptions = [
      '[BUG] `src/a/b.ts` requires implementation',
      '[TEST] `src/a/b.ts` requires inspection',
    ]
    const implementation = { issueNumber: await forge.createIssue({
      title: descriptions[0]!,
      body: buildIssueBody(descriptions[0]!, 'scan-1'),
      labels: [LABEL_FINDING, LABEL_READY],
    }) }
    const inspection = { issueNumber: await forge.createIssue({
      title: descriptions[1]!,
      body: buildIssueBody(descriptions[1]!, 'scan-1', undefined, undefined, true),
      labels: [LABEL_FINDING, LABEL_READY],
    }) }

    await expect(claimIssueGroup(
      forge,
      paths,
      await Promise.all([implementation, inspection]
        .map(({ issueNumber }) => forge.getIssue(issueNumber))),
      'worker-a',
      () => {},
    )).rejects.toThrow('cannot mix inspection and implementation')

    for (const { issueNumber } of [implementation, inspection]) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.labels).toContain(LABEL_READY)
      expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
      expect(issue.assignees).toEqual([])
    }
  })

  it('releases earlier members when a grouped claim loses a later issue', async () => {
    const issueNumbers = await Promise.all([
      readyIssue('[BUG] `src/a/b.ts` loses the first member'),
      readyIssue('[TEST] `src/a/b.ts` is already being claimed'),
    ])
    await forge.assignIssue(issueNumbers[1]!, 'worker-b')

    const result = await claimIssueGroup(
      forge,
      paths,
      await Promise.all(issueNumbers.map((number) => forge.getIssue(number))),
      'worker-a',
      () => {},
    )

    expect(result).toEqual({ outcome: 'lost-race', issueNumber: issueNumbers[1] })
    const released = await forge.getIssue(issueNumbers[0]!)
    expect(released.labels).toContain(LABEL_READY)
    expect(released.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(released.assignees).toEqual([])
    expect(readdirSync(paths.tasksDir)).toEqual([])
  })

  it('claims a collaborator-authored issue and materializes its framed specification', async () => {
    const issueNumber = await readyIssue('[BUG] `src/a/b.ts` breaks on empty input')
    const stored = forge.issues.get(issueNumber)
    if (stored === undefined) throw new Error('expected ready issue')
    stored.author = { login: 'collaborator-user', hasWriteAccess: true }
    const issue = await forge.getIssue(issueNumber)
    const result = await claimIssue(forge, paths, issue, 'worker-a', appendRequirement)
    if (result.outcome !== 'claimed') throw new Error(`expected a claim, got ${result.outcome}`)

    const after = await forge.getIssue(issueNumber)
    expect(after.assignees).toEqual(['worker-a'])
    expect(after.labels).toContain(LABEL_IN_PROGRESS)
    expect(after.labels).not.toContain(LABEL_READY)

    const spec = readFileSync(join(paths.tasksDir, `${result.taskId}.md`), 'utf8')
    expect(spec).toContain('TASK_COMPLETE')
    expect(spec).toContain('[BUG] `src/a/b.ts` breaks on empty input')
    // The claim refused every author without write access before this text was written,
    // so the requirement is a specification rather than untrusted data. What the claim
    // cannot vouch for stays refused.
    expect(spec).toContain('<<<REQUESTED_CHANGE>>>')
    expect(spec).toContain('<<<END_REQUESTED_CHANGE>>>')
    expect(spec).not.toContain('<<<UNTRUSTED_REQUEST_TEXT>>>')
    expect(spec).toContain('the forge confirmed has write access')
    expect(spec).toContain('Treat it as the specification for this task.')
    expect(spec).toContain('read or transmit credentials')
    expect(spec).toContain('the issue claim gate, the author write-access check, or the rules framing untrusted text')
    expect(readFileSync(join(paths.queueDir, 'effort', result.taskId), 'utf8').trim()).toBe('high')
    expect(issueNumberForTask(paths, result.taskId)).toBe(issueNumber)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toContain(result.taskId)
  })

  it.each([
    ['review', '20260808_000000_001_review-c1', '_fix-'],
    ['scan', '20260808_000000_002_scan', '_auto-'],
  ])('carries a %s parent into the materialized task id', async (_kind, parent, idKind) => {
    const description = `[BUG] \`src/a/b.ts\` preserves the ${_kind} origin`
    const published = await publishFinding(forge, paths, description, parent)

    const result = await claimIssue(
      forge, paths, await forge.getIssue(published.issueNumber), 'worker-a', appendRequirement,
    )
    if (result.outcome !== 'claimed') throw new Error(`expected a claim, got ${result.outcome}`)

    expect(result.taskId).toContain(idKind)
  })

  it('materializes a hand-written issue without a fingerprint', async () => {
    const issueNumber = await forge.createIssue({
      title: 'hand-written',
      body: [
        '## Requirement',
        '',
        'Fix the hand-written issue.',
        '',
        '## Reporter context',
        '',
        'This section is not part of the task.',
      ].join('\n'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    const result = await claimIssue(
      forge, paths, await forge.getIssue(issueNumber), 'worker-a', appendRequirement,
    )
    if (result.outcome !== 'claimed') throw new Error(`expected a claim, got ${result.outcome}`)

    const spec = readFileSync(join(paths.tasksDir, `${result.taskId}.md`), 'utf8')
    expect(spec).toContain('Fix the hand-written issue.')
    expect(spec).not.toContain('This section is not part of the task.')
  })

  it('labels an outsider-authored issue without claiming or materializing it', async () => {
    const issueNumber = await readyIssue('[BUG] `src/a/b.ts` asks for a change')
    const stored = forge.issues.get(issueNumber)
    if (stored === undefined) throw new Error('expected ready issue')
    stored.author = { login: 'outside-user', hasWriteAccess: false }

    const result = await claimIssue(
      forge, paths, await forge.getIssue(issueNumber), 'worker-a', appendRequirement,
    )

    expect(result).toEqual({
      outcome: 'untrusted-author', issueNumber, author: 'outside-user',
    })
    const after = await forge.getIssue(issueNumber)
    expect(after.labels).toContain(LABEL_READY)
    expect(after.labels).toContain(LABEL_UNTRUSTED_AUTHOR)
    expect(after.assignees).toEqual([])
    expect(readdirSync(paths.tasksDir)).toEqual([])
    expect(existsSync(join(paths.queueDir, 'backlog.txt'))).toBe(false)
  })

  it('preserves a finding issue depth when claiming it', async () => {
    const result = await publishFinding(
      forge, paths, '[BUG] `src/deep.ts` remains broken', 'parent-task',
      undefined, undefined, undefined, 2,
    )
    const claim = await claimIssue(
      forge, paths, await forge.getIssue(result.issueNumber), 'worker-a', appendRequirement,
    )
    if (claim.outcome !== 'claimed') throw new Error(`expected a claim, got ${claim.outcome}`)

    expect(claim.enqueue).toEqual({ outcome: 'enqueued', taskId: claim.taskId, depth: 2 })
  })

  it('mints and indexes a fresh task when an identical non-advisory finding returns after merge', async () => {
    const description = '[BUG] `src/a/b.ts` breaks on empty input'
    const firstIssueNumber = await readyIssue(description)
    const first = await claimIssue(
      forge, paths, await forge.getIssue(firstIssueNumber), 'worker-a', appendRequirement,
    )
    if (first.outcome !== 'claimed') throw new Error(`expected a claim, got ${first.outcome}`)
    writeFileSync(join(paths.statusDir, `${first.taskId}.json`),
      JSON.stringify({ task_id: first.taskId, status: 'merged' }))
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    recordIssuePromotion(paths, first.taskId, 'a'.repeat(40), 'chore/run-branch')

    const secondIssueNumber = await readyIssue(description)
    const second = await claimIssue(
      forge, paths, await forge.getIssue(secondIssueNumber), 'worker-a', appendRequirement,
    )
    if (second.outcome !== 'claimed') throw new Error(`expected a claim, got ${second.outcome}`)

    expect(second.taskId).not.toBe(first.taskId)
    expect(second.enqueue).toEqual({ outcome: 'enqueued', taskId: second.taskId, depth: 1 })
    expect(existingTaskIdForDesc(paths, 'auto', description)).toBe(second.taskId)
    expect(issueNumberForTask(paths, second.taskId)).toBe(secondIssueNumber)
  })

  it('settles a simultaneous claim deterministically — first login wins, loser backs off', async () => {
    const issueNumber = await readyIssue('[BUG] `src/a/b.ts` breaks')
    const issue = await forge.getIssue(issueNumber)
    // worker-b arrives between worker-z's assign and its re-read: both are assignees.
    await forge.assignIssue(issueNumber, 'worker-b')
    const result = await claimIssue(forge, paths, issue, 'worker-z', appendRequirement)
    expect(result.outcome).toBe('lost-race')
    const after = await forge.getIssue(issueNumber)
    expect(after.assignees).toEqual(['worker-b'])
    expect(after.labels).toContain(LABEL_READY)
  })

  it.each([
    ['adding in-progress', 'addLabel'],
    ['removing ready', 'removeLabel'],
  ] as const)('releases the issue when %s fails during a claim', async (_description, method) => {
    const issueNumber = await readyIssue('[BUG] `src/a/b.ts` breaks during label mutation')
    const issue = await forge.getIssue(issueNumber)
    const mutateLabel = forge[method].bind(forge)
    let failed = false
    forge[method] = async (number, label) => {
      await mutateLabel(number, label)
      if (number === issueNumber && !failed) {
        failed = true
        throw new Error(`${method} failed after applying`)
      }
    }

    await expect(claimIssue(forge, paths, issue, 'worker-a', appendRequirement))
      .rejects.toThrow(`${method} failed after applying`)

    const after = await forge.getIssue(issueNumber)
    expect(after.assignees).toEqual([])
    expect(after.labels).toContain(LABEL_READY)
    expect(after.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(existsSync(join(paths.queueDir, 'backlog.txt'))).toBe(false)
    expect(readdirSync(paths.tasksDir)).toEqual([])
  })

  it.each([
    ['writing the task spec', () => {
      rmSync(paths.tasksDir, { recursive: true })
      writeFileSync(paths.tasksDir, '')
    }],
    ['recording the issue mapping', () => {
      writeFileSync(join(paths.queueDir, 'issue-map'), '')
    }],
    ['enqueueing the task', () => {
      mkdirSync(join(paths.queueDir, 'backlog.txt'))
    }],
  ] as const)(
    'releases the issue when %s fails after the remote claim',
    async (_description, setUpFailure) => {
      const issueNumber = await readyIssue('[BUG] `src/a/b.ts` fails during materialization')
      const issue = await forge.getIssue(issueNumber)
      setUpFailure()

      await expect(claimIssue(forge, paths, issue, 'worker-a', appendRequirement)).rejects.toThrow()

      const after = await forge.getIssue(issueNumber)
      expect(after.assignees).toEqual([])
      expect(after.labels).toContain(LABEL_READY)
      expect(after.labels).not.toContain(LABEL_IN_PROGRESS)
    },
  )

  it('discards a partial task and its description index when requirements fail to append', async () => {
    const description = '[BUG] `src/a/b.ts` fails while appending requirements'
    const issueNumber = await readyIssue(description)
    const issue = await forge.getIssue(issueNumber)
    let failedTaskId: string | undefined

    await expect(claimIssue(forge, paths, issue, 'worker-a', (taskId) => {
      failedTaskId = taskId
      writeFileSync(specFile(paths, taskId), 'partial requirement')
      throw new Error('append failed')
    })).rejects.toThrow('append failed')

    if (failedTaskId === undefined) throw new Error('expected append to be attempted')
    const released = await forge.getIssue(issueNumber)
    expect(released.assignees).toEqual([])
    expect(released.labels).toContain(LABEL_READY)
    expect(released.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(existsSync(specFile(paths, failedTaskId))).toBe(false)
    expect(existingTaskIdForDesc(paths, 'auto', description)).toBeUndefined()
    expect(readdirSync(join(paths.queueDir, 'desc-index'))).toEqual([])

    const retry = await claimIssue(
      forge, paths, await forge.getIssue(issueNumber), 'worker-a', appendRequirement,
    )
    if (retry.outcome !== 'claimed') throw new Error(`expected a claim, got ${retry.outcome}`)
    expect(retry.taskId).not.toBe(failedTaskId)
    expect(readFileSync(specFile(paths, retry.taskId), 'utf8')).toContain(description)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toContain(retry.taskId)
  })

  it('quarantines an unparseable issue with an actionable reason', async () => {
    const issueNumber = await forge.createIssue({
      title: 'hand-written', body: 'no structure here', labels: [LABEL_FINDING, LABEL_READY],
    })
    const issue = await forge.getIssue(issueNumber)
    const result = await claimIssue(forge, paths, issue, 'worker-a', appendRequirement)
    if (result.outcome !== 'unparseable') {
      throw new Error(`expected an unparseable claim, got ${result.outcome}`)
    }
    expect(result).toEqual({
      outcome: 'unparseable',
      issueNumber,
      reason: `Issue #${issueNumber} cannot be materialized: missing \`## Requirement\` heading. Fix the issue body, remove ${LABEL_MERGE_FAILED}, add ${LABEL_READY}, unassign the worker, and restart the loop.`,
    })
    const after = await forge.getIssue(issueNumber)
    expect(after.assignees).toEqual(['worker-a'])
    expect(after.labels).toContain(LABEL_MERGE_FAILED)
    expect(after.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(forge.issueComments.get(issueNumber)).toEqual([result.reason])
  })

  it('releases an unparseable issue when its quarantine comment fails after applying', async () => {
    const issueNumber = await forge.createIssue({
      title: 'hand-written', body: 'no structure here', labels: [LABEL_FINDING, LABEL_READY],
    })
    const commentIssue = forge.commentIssue.bind(forge)
    forge.commentIssue = async (number, comment) => {
      await commentIssue(number, comment)
      throw new Error('commentIssue failed after applying')
    }

    await expect(claimIssue(
      forge, paths, await forge.getIssue(issueNumber), 'worker-a', appendRequirement,
    )).rejects.toThrow('commentIssue failed after applying')

    const after = await forge.getIssue(issueNumber)
    expect(after.assignees).toEqual([])
    expect(after.labels).toContain(LABEL_READY)
    expect(after.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(after.labels).not.toContain(LABEL_MERGE_FAILED)
  })

  it('names an empty requirement when quarantining an issue', async () => {
    const issueNumber = await forge.createIssue({
      title: 'empty',
      body: '## Requirement\n\n## Reporter\n\nContext only.',
      labels: [LABEL_FINDING, LABEL_READY],
    })

    const result = await claimIssue(
      forge, paths, await forge.getIssue(issueNumber), 'worker-a', appendRequirement,
    )

    expect(result).toMatchObject({
      outcome: 'unparseable',
      issueNumber,
      reason: expect.stringContaining('empty requirement'),
    })
  })

  it('serializes a claim with duplicate reconciliation and does not materialize a closed issue', async () => {
    const description = '[BUG] `src/a/b.ts` breaks'
    await readyIssue(description)
    const duplicate = await forge.createIssue({
      title: description,
      body: buildIssueBody(description, 'scan-2'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const issue = await forge.getIssue(duplicate)
    const closeIssue = forge.closeIssue.bind(forge)
    let releaseClose: () => void = () => {}
    let closeStarted: () => void = () => {}
    const mayClose = new Promise<void>((resolve) => { releaseClose = resolve })
    const closing = new Promise<void>((resolve) => { closeStarted = resolve })
    forge.closeIssue = async (issueNumber, comment) => {
      if (issueNumber === duplicate) {
        closeStarted()
        await mayClose
      }
      await closeIssue(issueNumber, comment)
    }

    const reconciliation = publishFinding(forge, paths, description, 'scan-3')
    await closing
    const claim = claimIssue(forge, paths, issue, 'worker-a', appendRequirement)
    releaseClose()

    await reconciliation
    expect(await claim).toEqual({ outcome: 'lost-race', issueNumber: duplicate })
    expect((await forge.getIssue(duplicate)).state).toBe('closed')
    expect(existsSync(join(paths.queueDir, 'backlog.txt'))).toBe(false)
    expect(readdirSync(paths.tasksDir)).toEqual([])
  })

  it('revalidates the claimed issue after relabeling and before writing local work', async () => {
    const issueNumber = await readyIssue('[BUG] `src/a/b.ts` breaks during claim')
    const issue = await forge.getIssue(issueNumber)
    const removeLabel = forge.removeLabel.bind(forge)
    const closeIssue = forge.closeIssue.bind(forge)
    forge.removeLabel = async (number, label) => {
      await removeLabel(number, label)
      if (number === issueNumber && label === LABEL_READY) {
        await closeIssue(number, 'Concurrent reconciliation')
      }
    }

    const result = await claimIssue(forge, paths, issue, 'worker-a', appendRequirement)

    expect(result).toEqual({ outcome: 'lost-race', issueNumber })
    expect((await forge.getIssue(issueNumber)).state).toBe('closed')
    expect(existsSync(join(paths.queueDir, 'backlog.txt'))).toBe(false)
    expect(readdirSync(paths.tasksDir)).toEqual([])
  })
})

describe('reapStaleLeases', () => {
  it('does not return a quarantined claim failure to the ready queue', async () => {
    const base = new Date('2026-08-08T12:00:00Z')
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'claim failed', body: 'malformed',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_MERGE_FAILED],
    })
    await forge.assignIssue(issueNumber, 'worker-a')

    expect(await reapStaleLeases(forge, paths, 3, base)).toEqual([])
    const after = await forge.getIssue(issueNumber)
    expect(after.assignees).toEqual(['worker-a'])
    expect(after.labels).not.toContain(LABEL_READY)
    expect(after.labels).toContain(LABEL_IN_PROGRESS)
  })

  it('returns quiet leases to ready and leaves live ones alone', async () => {
    const base = new Date('2026-08-08T12:00:00Z')
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const stale = await forge.createIssue({
      title: 'stale', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'), labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    await forge.assignIssue(stale, 'worker-gone')

    forge.clock = () => new Date('2026-08-08T11:30:00Z')
    const live = await forge.createIssue({
      title: 'live', body: buildIssueBody('[BUG] `c/d.ts` y', 'p'), labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    await forge.assignIssue(live, 'worker-busy')

    const reaped = await reapStaleLeases(forge, paths, 3, base)
    expect(reaped).toEqual([stale])
    const staleAfter = await forge.getIssue(stale)
    expect(staleAfter.assignees).toEqual([])
    expect(staleAfter.labels).toContain(LABEL_READY)
    const liveAfter = await forge.getIssue(live)
    expect(liveAfter.assignees).toEqual(['worker-busy'])
    expect(liveAfter.labels).toContain(LABEL_IN_PROGRESS)
  })

  it('immediately retries when adding ready fails after unassignment', async () => {
    const now = new Date('2026-08-08T12:00:00Z')
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'partial reap', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-gone'],
    })
    forge.clock = () => now
    const addLabel = forge.addLabel.bind(forge)
    let failReady = true
    forge.addLabel = async (number, label) => {
      if (label === LABEL_READY && failReady) {
        failReady = false
        throw new Error('addLabel failed')
      }
      await addLabel(number, label)
    }

    await expect(reapStaleLeases(forge, paths, 3, now)).rejects.toThrow('addLabel failed')
    const partial = await forge.getIssue(issueNumber)
    expect(partial.assignees).toEqual([])
    expect(partial.labels).not.toContain(LABEL_READY)
    expect(partial.labels).toContain(LABEL_IN_PROGRESS)
    expect(partial.updatedAt).toBe(now.toISOString())

    expect(await reapStaleLeases(forge, paths, 3, now)).toEqual([issueNumber])
    const recovered = await forge.getIssue(issueNumber)
    expect(recovered.labels).toContain(LABEL_READY)
    expect(recovered.labels).not.toContain(LABEL_IN_PROGRESS)
  })

  it('immediately retries when removing in-progress fails after adding ready', async () => {
    const now = new Date('2026-08-08T12:00:00Z')
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'partial reap', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-gone'],
    })
    forge.clock = () => now
    const removeLabel = forge.removeLabel.bind(forge)
    let failInProgress = true
    forge.removeLabel = async (number, label) => {
      if (label === LABEL_IN_PROGRESS && failInProgress) {
        failInProgress = false
        throw new Error('removeLabel failed')
      }
      await removeLabel(number, label)
    }

    await expect(reapStaleLeases(forge, paths, 3, now)).rejects.toThrow('removeLabel failed')
    const partial = await forge.getIssue(issueNumber)
    expect(partial.assignees).toEqual([])
    expect(partial.labels).toContain(LABEL_READY)
    expect(partial.labels).toContain(LABEL_IN_PROGRESS)
    expect(partial.updatedAt).toBe(now.toISOString())

    expect(await reapStaleLeases(forge, paths, 3, now)).toEqual([issueNumber])
    const recovered = await forge.getIssue(issueNumber)
    expect(recovered.labels).toContain(LABEL_READY)
    expect(recovered.labels).not.toContain(LABEL_IN_PROGRESS)
  })

  it('revalidates a stale listing after a concurrent heartbeat before reaping', async () => {
    const now = new Date('2026-08-08T12:00:00Z')
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'stale snapshot', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-busy'],
    })
    const staleListing = await forge.listOpenIssues(LABEL_IN_PROGRESS)
    forge.clock = () => new Date('2026-08-08T11:30:00Z')

    const reaped = await reapStaleLeases(
      forge, paths, 3, now, new Set(), staleListing,
      async (issue) => {
        await forge.commentIssue(issue.number, 'Heartbeat: 2026-08-08T11:30:00.000Z')
        return false
      },
    )

    expect(reaped).toEqual([])
    const after = await forge.getIssue(issueNumber)
    expect(after.assignees).toEqual(['worker-busy'])
    expect(after.labels).toContain(LABEL_IN_PROGRESS)
    expect(after.labels).not.toContain(LABEL_READY)
  })

  it('does not mutate lease labels or assignees changed after listing', async () => {
    const now = new Date('2026-08-08T12:00:00Z')
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const relabeled = await forge.createIssue({
      title: 'relabeled', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-a'],
    })
    const reassigned = await forge.createIssue({
      title: 'reassigned', body: buildIssueBody('[BUG] `c/d.ts` y', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-a'],
    })
    const staleListing = await forge.listOpenIssues(LABEL_IN_PROGRESS)
    const hasMergeMarker = async (issue: ForgeIssue): Promise<boolean> => {
      const current = forge.issues.get(issue.number)
      if (current === undefined) throw new Error(`expected issue #${issue.number}`)
      if (issue.number === relabeled) current.labels.push(LABEL_MERGE_FAILED)
      if (issue.number === reassigned) current.assignees = ['worker-b']
      return false
    }

    expect(await reapStaleLeases(
      forge, paths, 3, now, new Set(), staleListing, hasMergeMarker,
    )).toEqual([])
    expect((await forge.getIssue(relabeled)).labels).toContain(LABEL_MERGE_FAILED)
    expect((await forge.getIssue(relabeled)).assignees).toEqual(['worker-a'])
    expect((await forge.getIssue(reassigned)).assignees).toEqual(['worker-b'])
    expect((await forge.getIssue(reassigned)).labels).toContain(LABEL_IN_PROGRESS)
  })

  it('uses persisted merge metadata after task status cleanup instead of reaping it', async () => {
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'merged', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-a'],
    })
    recordIssueForTask(paths, 'task-merged', issueNumber)
    recordIssuePromotion(paths, 'task-merged', 'abc123', 'feature/run-9')
    forge.clock = () => new Date('2026-08-08T12:00:00Z')

    const reap = () => reapStaleLeases(
      forge, paths, 3, new Date('2026-08-08T12:00:00Z'),
    )
    await expect(reap()).resolves.toEqual([])
    await expect(reap()).resolves.toEqual([])

    const issue = await forge.getIssue(issueNumber)
    expect(issue.assignees).toEqual(['worker-a'])
    expect(issue.labels).toContain(LABEL_IN_PROGRESS)
    expect(forge.issueComments.get(issueNumber)).toEqual([
      'MERGED: task-merged\nMerged as abc123 into run branch feature/run-9. This issue closes on promotion.',
    ])
  })

  it('does not reap an issue with a collaborator merge marker when the local issue map is empty', async () => {
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'merged elsewhere', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-a'],
    })
    await forge.commentIssue(issueNumber,
      'MERGED: 20260808_000000_001_auto-remote-fix\nMerged by another checkout.')
    forge.issueCommentAuthors.set(issueNumber, [
      { login: 'collaborator-user', hasWriteAccess: true },
    ])

    const reaped = await reapStaleLeases(
      forge, paths, 3, new Date('2026-08-08T12:00:00Z'),
    )

    expect(reaped).toEqual([])
    const issue = await forge.getIssue(issueNumber)
    expect(issue.assignees).toEqual(['worker-a'])
    expect(issue.labels).toContain(LABEL_IN_PROGRESS)
    expect(issue.labels).not.toContain(LABEL_READY)
    expect(existsSync(join(paths.queueDir, 'issue-map'))).toBe(false)
  })

  it('does reap an issue when its only merge marker was written by an outsider', async () => {
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'forged merge', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-a'],
    })
    await forge.commentIssue(issueNumber, 'MERGED: forged-task\nMerged by another checkout.')
    forge.issueCommentAuthors.set(issueNumber, [
      { login: 'outside-user', hasWriteAccess: false },
    ])

    expect(await reapStaleLeases(
      forge, paths, 3, new Date('2026-08-08T12:00:00Z'),
    )).toEqual([issueNumber])
    const issue = await forge.getIssue(issueNumber)
    expect(issue.assignees).toEqual([])
    expect(issue.labels).toContain(LABEL_READY)
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
  })

  it('removes persisted merge metadata after promotion closes the issue', async () => {
    const issueNumber = await forge.createIssue({
      title: 'merged', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-a'],
    })
    recordIssueForTask(paths, 'task-merged', issueNumber)
    recordIssuePromotion(paths, 'task-merged', 'abc123', 'feature/run-9')
    await forge.closeIssue(issueNumber, 'promoted')

    await reapStaleLeases(forge, paths, 3, new Date('2026-08-08T12:00:00Z'))

    expect(readdirSync(join(paths.queueDir, 'issue-promotion'))).toEqual([])
    expect(issueNumberForTask(paths, 'task-merged')).toBeUndefined()
  })

  it('keeps a grouped task map until every promoted issue has closed', async () => {
    const issueNumbers = await Promise.all([1, 2].map((index) => forge.createIssue({
      title: `merged group ${index}`,
      body: buildIssueBody(`[BUG] \`a/b.ts\` grouped ${index}`, 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-a'],
    })))
    recordIssuesForTask(paths, 'task-grouped', issueNumbers)
    recordIssuePromotions(paths, 'task-grouped', 'abc123', 'feature/run-9')
    await forge.closeIssue(issueNumbers[0]!, 'partially promoted')

    await reapStaleLeases(forge, paths, 3, new Date('2026-08-08T12:00:00Z'))

    expect(issueNumbersForTask(paths, 'task-grouped')).toEqual(issueNumbers)
    expect(issuePromotionForIssue(paths, issueNumbers[1]!)).toBeDefined()

    await forge.closeIssue(issueNumbers[1]!, 'fully promoted')
    await reapStaleLeases(forge, paths, 3, new Date('2026-08-08T12:00:00Z'))
    expect(issueNumbersForTask(paths, 'task-grouped')).toEqual([])
  })

  it('reaps a stale mapped lease when its local task is not merged', async () => {
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'quiet', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-gone'],
    })
    recordIssueForTask(paths, 'task-completed', issueNumber)
    writeFileSync(join(paths.statusDir, 'task-completed.json'),
      JSON.stringify({ task_id: 'task-completed', status: 'completed' }))

    const reaped = await reapStaleLeases(
      forge, paths, 3, new Date('2026-08-08T12:00:00Z'),
    )

    expect(reaped).toEqual([issueNumber])
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_READY)
    expect(forge.issueComments.has(issueNumber)).toBe(false)
  })
})

describe('worker heartbeats', () => {
  it('refreshes a linked task after 30 minutes without replacing a concurrent body edit', async () => {
    forge.clock = () => new Date('2026-08-08T12:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'linked', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssueForTask(paths, 'task-linked', issueNumber)
    const editedBody = `${buildIssueBody('[BUG] `a/b.ts` x', 'p')}\nHuman note\n`
    const issue = forge.issues.get(issueNumber)
    if (issue === undefined) throw new Error('expected linked issue')
    issue.body = editedBody

    expect(await heartbeatIssueForTask(forge, paths, 'task-linked', new Date('2026-08-08T12:00:00Z')))
      .toBe(true)
    expect(await heartbeatIssueForTask(forge, paths, 'task-linked', new Date('2026-08-08T12:29:59Z')))
      .toBe(false)

    forge.clock = () => new Date('2026-08-08T12:30:00Z')
    expect(await heartbeatIssueForTask(forge, paths, 'task-linked', new Date('2026-08-08T12:30:00Z')))
      .toBe(true)
    expect((await forge.getIssue(issueNumber)).body).toBe(editedBody)
    expect(forge.issueComments.get(issueNumber)).toEqual([
      'Heartbeat: 2026-08-08T12:00:00.000Z',
      'Heartbeat: 2026-08-08T12:30:00.000Z',
    ])
  })

  it('comments with the merge linkage and refreshes the issue timestamp', async () => {
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'merged', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    forge.clock = () => new Date('2026-08-08T12:00:00Z')

    await commentOnIssueMerge(forge, issueNumber, 'task-merged', 'abc123', 'feature/run-9')

    expect(forge.issueComments.get(issueNumber)).toEqual([
      'MERGED: task-merged\nMerged as abc123 into run branch feature/run-9. This issue closes on promotion.',
    ])
    expect((await forge.getIssue(issueNumber)).updatedAt).toBe('2026-08-08T12:00:00.000Z')
  })
})

describe('issue map', () => {
  it('records and resolves the task-to-issue mapping', () => {
    recordIssueForTask(paths, 'task-x', 42)
    expect(issueNumberForTask(paths, 'task-x')).toBe(42)
    expect(issueNumberForTask(paths, 'task-unknown')).toBeUndefined()
  })
})

describe('publishDelegatedTask', () => {
  it('publishes ready work for the daemon and never materializes under the delegator login', async () => {
    const description = '[BUG] `src/a/b.ts` Remove empty .live-event-form rules'
    const first = await publishDelegatedTask(
      forge, paths, description, 'user-task-1', 'high', true,
    )
    const second = await publishDelegatedTask(
      forge, paths, '[BUG] The empty rules for .live-event-form should be removed in `src/a/b.ts`',
      'user-task-2',
    )

    expect(first).toEqual({ outcome: 'created', issueNumber: 1, materialize: false })
    expect(second).toEqual({ outcome: 'duplicate', issueNumber: 1, materialize: false })
    expect(forge.issues.size).toBe(1)
    const ready = await forge.getIssue(1)
    expect(ready.assignees).toEqual([])
    expect(ready.labels).toEqual([LABEL_FINDING, LABEL_READY])
    expect(issueNumberForTask(paths, 'user-task-1')).toBeUndefined()
    expect(issueNumberForTask(paths, 'user-task-2')).toBeUndefined()

    const claim = await claimIssue(forge, paths, ready, forge.user, () => {})
    if (claim.outcome !== 'claimed') throw new Error(`expected a claim, got ${claim.outcome}`)
    expect((await forge.getIssue(1)).assignees).toEqual([forge.user])
    expect(readFileSync(join(paths.queueDir, 'effort', claim.taskId), 'utf8')).toBe('high\n')
    expect(existsSync(join(paths.queueDir, 'inspect', claim.taskId))).toBe(true)
  })

  it('does not attach a local task to a matching issue claimed by another worker', async () => {
    const description = '[BUG] `src/a/b.ts` breaks delegated work'
    const issueNumber = await forge.createIssue({
      title: description,
      body: buildIssueBody(description, 'worker-task'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-busy'],
    })

    const result = await publishDelegatedTask(
      forge, paths, description, 'user-task',
    )

    expect(result).toEqual({ outcome: 'duplicate', issueNumber, materialize: false })
    expect(issueNumberForTask(paths, 'user-task')).toBeUndefined()
    expect((await forge.getIssue(issueNumber)).assignees).toEqual(['worker-busy'])
  })
})

describe('loop integration in issue mode', () => {
  it('publishes findings as issues instead of enqueuing, and claims them back into work', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot })
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repoRoot })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoRoot })
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    execFileSync('git', ['add', '-A'], { cwd: repoRoot })
    execFileSync('git', ['commit', '-qm', 'chore: init'], { cwd: repoRoot })

    const { createLoop } = await import('../src/loop.ts')
    const { loadConfig } = await import('../src/config.ts')
    const { finalMessageFile } = await import('../src/paths.ts')
    const started: string[] = []
    const logged: string[] = []
    const loop = createLoop({
      paths,
      config: {
        ...loadConfig({}),
        issueQueueEnabled: true,
        scanEnabled: false,
        autoMerge: false,
        maxParallel: 1,
      },
      forge,
      runner: {
        sharedSkills: fakeRunnerSharedSkills,
        start: async (options) => { started.push(options.specFile); return process.pid },
      },
      project: stubProject,
      log: (line) => logged.push(line),
      now: () => new Date('2026-08-08T12:00:00Z'),
    })
    loop.initializeSessionStateForBranch()

    // A completed scan's finding becomes an issue, not a local queue entry.
    writeFileSync(finalMessageFile(paths, '20260808_000000_001_scan'),
      'NEXT_TASK: [BUG] `src/a/b.ts` breaks on empty input\nTASK_COMPLETE\n')
    writeFileSync(join(paths.statusDir, '20260808_000000_001_scan.json'),
      JSON.stringify({ task_id: '20260808_000000_001_scan', status: 'completed', pid: null }))

    // One poll carries the finding all the way: published as an issue by the
    // completion scan, then claimed and started by the same poll's fill step.
    await loop.poll()
    expect(forge.issues.size).toBe(1)
    expect(started).toHaveLength(1)
    const claimed = [...forge.issues.values()][0]
    expect(claimed?.assignees).toEqual(['worker-a'])
    expect(claimed?.labels).toContain(LABEL_IN_PROGRESS)
    expect(claimed?.labels).not.toContain(LABEL_READY)
    expect(logged).toContain('Filed #1          by 001_scan')
    expect(logged).toContain('Completed 001_scan    findings #1')
    expect(logged.some((line) => line.includes('NEXT_TASK detection'))).toBe(false)

    // A duplicate hidden beyond the creation retry window is still reconciled by
    // a later poll, even though the fingerprint is never published again.
    const duplicate = await forge.createIssue({
      title: 'late duplicate',
      body: buildIssueBody('[BUG] `src/a/b.ts` breaks on empty input', 'another-scan'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    await loop.poll()
    expect((await forge.getIssue(duplicate)).state).toBe('closed')
  })

  it('heartbeats a linked running task before reaping while an unlinked stale lease is reaped', async () => {
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const linked = await forge.createIssue({
      title: 'linked', body: buildIssueBody('[BUG] `src/a.ts` breaks', 'scan'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    const unlinked = await forge.createIssue({
      title: 'unlinked', body: buildIssueBody('[BUG] `src/b.ts` breaks', 'scan'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    await forge.assignIssue(linked, 'worker-a')
    await forge.assignIssue(unlinked, 'worker-gone')
    recordIssueForTask(paths, 'task-running', linked)
    writeFileSync(join(paths.statusDir, 'task-running.json'),
      JSON.stringify({ task_id: 'task-running', status: 'running', pid: process.pid }))
    recordTaskProcess(paths, 'task-running', process.pid)
    forge.clock = () => new Date('2026-08-08T12:00:00Z')

    const { createLoop } = await import('../src/loop.ts')
    const { loadConfig } = await import('../src/config.ts')
    const loop = createLoop({
      paths,
      config: {
        ...loadConfig({}), issueQueueEnabled: true, scanEnabled: false,
        autoMerge: false, maxParallel: 1,
      },
      forge,
      runner: { sharedSkills: fakeRunnerSharedSkills, start: async () => process.pid },
      project: stubProject,
      log: () => {},
      now: () => new Date('2026-08-08T12:00:00Z'),
    })

    await expect(loop.poll()).resolves.toBe('continue')
    const linkedAfter = await forge.getIssue(linked)
    expect(linkedAfter.assignees).toEqual(['worker-a'])
    expect(linkedAfter.labels).toContain(LABEL_IN_PROGRESS)
    expect(forge.issueComments.get(linked)).toEqual(['Heartbeat: 2026-08-08T12:00:00.000Z'])
    const unlinkedAfter = await forge.getIssue(unlinked)
    expect(unlinkedAfter.assignees).toEqual([])
    expect(unlinkedAfter.labels).toContain(LABEL_READY)
  })

  it('does not reap a locally running task when its stale heartbeat fails', async () => {
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'linked', body: buildIssueBody('[BUG] `src/a.ts` breaks', 'scan'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-a'],
    })
    recordIssueForTask(paths, 'task-running', issueNumber)
    writeFileSync(join(paths.statusDir, 'task-running.json'),
      JSON.stringify({ task_id: 'task-running', status: 'running', pid: process.pid }))
    recordTaskProcess(paths, 'task-running', process.pid)
    forge.clock = () => new Date('2026-08-08T12:00:00Z')
    forge.commentIssue = async () => { throw new Error('forge unavailable') }
    const logged: string[] = []

    const { createLoop } = await import('../src/loop.ts')
    const { loadConfig } = await import('../src/config.ts')
    const loop = createLoop({
      paths,
      config: { ...loadConfig({}), issueQueueEnabled: true, scanEnabled: false, autoMerge: false },
      forge,
      runner: { sharedSkills: fakeRunnerSharedSkills, start: async () => process.pid },
      project: stubProject,
      log: (line) => logged.push(line),
      now: () => new Date('2026-08-08T12:00:00Z'),
    })

    await expect(loop.poll()).resolves.toBe('continue')
    expect(logged.filter((line) => line.includes('WARN heartbeat failed'))).toHaveLength(1)
    const issue = await forge.getIssue(issueNumber)
    expect(issue.assignees).toEqual(['worker-a'])
    expect(issue.labels).toContain(LABEL_IN_PROGRESS)
    expect(issue.labels).not.toContain(LABEL_READY)
  })

})
