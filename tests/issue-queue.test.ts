import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildIssueBody, claimIssue, closeIssueAndRemoveLifecycleLabels, commentOnIssueMerge,
  fingerprintOf, heartbeatIssueForTask, issueNumberForTask, parseIssueBody,
  publishDelegatedTask, publishFinding, reapStaleLeases,
  reconcileClosedIssueLifecycleLabels, reconcileFindingFingerprints, recordIssueForTask,
  recordIssuePromotion, LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_MERGE_FAILED,
  LABEL_MERGE_READY, LABEL_READY,
} from '../src/issueQueue.ts'
import { existingTaskIdForDesc } from '../src/ids.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'

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

  it('identifies an ordinary finding by tag and first named path', () => {
    expect(fingerprintOf('[BUG] `src/frontend/src/pages/StatisticsPage.tsx` accepts an inverted range'))
      .toBe('bug:src/frontend/src/pages/StatisticsPage.tsx')
  })

  it('falls back to hashed text with whole-line semantics', () => {
    const a = fingerprintOf('adopt the new expense model or keep the current one')
    const b = fingerprintOf('adopt the new expense model or keep the current one')
    const c = fingerprintOf('drop the legacy artist link or migrate it')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('text:')).toBe(true)
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
    const body = buildIssueBody('[BUG] `src/x/y.ts` does the wrong thing', 'parent-task', 'high')
    const parsed = parseIssueBody(body)
    expect(parsed?.fingerprint).toBe('bug:src/x/y.ts')
    expect(parsed?.effort).toBe('high')
    expect(parsed?.inspect).toBe(false)
    expect(parsed?.requirement).toBe('[BUG] `src/x/y.ts` does the wrong thing')
  })

  it('refuses a body without structure', () => {
    expect(parseIssueBody('just prose, no fields')).toBeUndefined()
  })
})

describe('publishFinding', () => {
  it('reports an immediate duplicate while the remote issue list still lags', async () => {
    forge.listOpenIssues = async () => []
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1')
    expect(first.outcome).toBe('created')
    const issue = await forge.getIssue(first.issueNumber)
    expect(issue.labels).toEqual([LABEL_FINDING, LABEL_READY])

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks in a different wording', 'scan-2')
    expect(second).toEqual({ outcome: 'duplicate', issueNumber: first.issueNumber })
    expect(forge.issues.size).toBe(1)
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
      publishFinding(forge, otherPaths, '[BUG] `src/a/b.ts` breaks differently', 'scan-2'),
    ])

    expect(results).toEqual([
      { outcome: 'created', issueNumber: 1 },
      { outcome: 'duplicate', issueNumber: 1 },
    ])
    expect((await listOpenIssues(LABEL_FINDING)).map((issue) => issue.number)).toEqual([1])
    expect((await forge.getIssue(2)).state).toBe('closed')
    expect(listCalls).toBeGreaterThanOrEqual(5)
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8')).toBe('bug:src/a/b.ts 1\n')
    expect(readFileSync(join(otherPaths.queueDir, 'issue-fingerprints'), 'utf8')).toBe('bug:src/a/b.ts 1\n')
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
      publishFinding(forge, otherPaths, '[BUG] `src/a/b.ts` breaks differently', 'scan-2'),
    ])
    expect(results).toEqual([
      { outcome: 'created', issueNumber: 1 },
      { outcome: 'created', issueNumber: 2 },
    ])

    forge.listOpenIssues = listOpenIssues
    await reconcileFindingFingerprints(forge, otherPaths)

    expect((await listOpenIssues(LABEL_FINDING)).map((issue) => issue.number)).toEqual([1])
    expect((await forge.getIssue(2)).state).toBe('closed')
    expect(readFileSync(join(otherPaths.queueDir, 'issue-fingerprints'), 'utf8')).toBe('bug:src/a/b.ts 1\n')
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
        `bug:src/a.ts ${combined.issueNumber}`,
        `test:src/b.test.ts ${combined.issueNumber}`,
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
    // The coarse tag+first-path fingerprint collapses distinct defects in one file;
    // once an issue's fix has merged locally, a fresh finding is new work, not a dup.
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'review-1')
    recordIssueForTask(paths, 'task-first-fix', first.issueNumber)
    recordIssuePromotion(paths, 'task-first-fix', 'a'.repeat(40), 'chore/run-branch')

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks differently', 'review-2')
    await reconcileFindingFingerprints(forge, paths)

    expect(second.outcome).toBe('created')
    expect(second.issueNumber).not.toBe(first.issueNumber)
    expect((await forge.getIssue(first.issueNumber)).state).toBe('open')
    expect((await forge.getIssue(second.issueNumber)).state).toBe('open')
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe(`bug:src/a/b.ts ${second.issueNumber}\n`)
  })

  it('still suppresses a same-fingerprint finding while the first issue is in progress', async () => {
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'review-1')
    await forge.assignIssue(first.issueNumber, 'worker-busy')
    await forge.addLabel(first.issueNumber, LABEL_IN_PROGRESS)
    await forge.removeLabel(first.issueNumber, LABEL_READY)

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks differently', 'review-2')

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

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks again', 'scan-2')

    expect(second).toEqual({ outcome: 'created', issueNumber: 2 })
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe('bug:src/a/b.ts 2\n')
  })

  it('drops a ledger entry when the open issue no longer carries its fingerprint', async () => {
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1')
    const issue = forge.issues.get(first.issueNumber)
    if (issue === undefined) throw new Error('expected the published issue')
    issue.body = buildIssueBody('[BUG] `src/other.ts` breaks', 'edited')

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks again', 'scan-2')

    expect(second).toEqual({ outcome: 'created', issueNumber: 2 })
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe('bug:src/a/b.ts 2\n')
  })

  it('drops a ledger entry when the open issue is no longer a finding', async () => {
    const first = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks', 'scan-1')
    const issue = forge.issues.get(first.issueNumber)
    if (issue === undefined) throw new Error('expected the published issue')
    issue.labels = issue.labels.filter((label) => label !== LABEL_FINDING)

    const second = await publishFinding(forge, paths, '[BUG] `src/a/b.ts` breaks again', 'scan-2')

    expect(second).toEqual({ outcome: 'created', issueNumber: 2 })
    expect(readFileSync(join(paths.queueDir, 'issue-fingerprints'), 'utf8'))
      .toBe('bug:src/a/b.ts 2\n')
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

  it('claims, labels, materializes a spec with the completion marker, and enqueues', async () => {
    const issueNumber = await readyIssue('[BUG] `src/a/b.ts` breaks on empty input')
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
    expect(readFileSync(join(paths.queueDir, 'effort', result.taskId), 'utf8').trim()).toBe('high')
    expect(issueNumberForTask(paths, result.taskId)).toBe(issueNumber)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toContain(result.taskId)
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

  it('leaves an unparseable issue claimed for a person instead of bouncing it', async () => {
    const issueNumber = await forge.createIssue({
      title: 'hand-written', body: 'no structure here', labels: [LABEL_FINDING, LABEL_READY],
    })
    const issue = await forge.getIssue(issueNumber)
    const result = await claimIssue(forge, paths, issue, 'worker-a', appendRequirement)
    expect(result.outcome).toBe('unparseable')
    const after = await forge.getIssue(issueNumber)
    expect(after.assignees).toEqual(['worker-a'])
    expect(after.labels).toContain(LABEL_IN_PROGRESS)
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

  it('does not reap an issue with a remote merge marker when the local issue map is empty', async () => {
    forge.clock = () => new Date('2026-08-08T06:00:00Z')
    const issueNumber = await forge.createIssue({
      title: 'merged elsewhere', body: buildIssueBody('[BUG] `a/b.ts` x', 'p'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-a'],
    })
    await forge.commentIssue(issueNumber,
      'MERGED: 20260808_000000_001_auto-remote-fix\nMerged by another checkout.')

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
    const description = '[BUG] `src/a/b.ts` breaks delegated work'
    const first = await publishDelegatedTask(
      forge, paths, description, 'user-task-1', 'high', true,
    )
    const second = await publishDelegatedTask(
      forge, paths, '[BUG] `src/a/b.ts` breaks with new wording', 'user-task-2',
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
      runner: { start: async (options) => { started.push(options.specFile); return process.pid } },
      project: { name: 'stub', mergeChecks: () => [], cycleSuite: () => [] },
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
    expect(logged).toContain('Filed #1  by 001_scan')
    expect(logged).toContain('Completed 001_scan  findings #1')
    expect(logged.some((line) => line.includes('NEXT_TASK detection'))).toBe(false)

    // A duplicate hidden beyond the creation retry window is still reconciled by
    // a later poll, even though the fingerprint is never published again.
    const duplicate = await forge.createIssue({
      title: 'late duplicate',
      body: buildIssueBody('[BUG] `src/a/b.ts` breaks differently', 'another-scan'),
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
      runner: { start: async () => process.pid },
      project: { name: 'stub', mergeChecks: () => [], cycleSuite: () => [] },
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
    forge.clock = () => new Date('2026-08-08T12:00:00Z')
    forge.commentIssue = async () => { throw new Error('forge unavailable') }
    const logged: string[] = []

    const { createLoop } = await import('../src/loop.ts')
    const { loadConfig } = await import('../src/config.ts')
    const loop = createLoop({
      paths,
      config: { ...loadConfig({}), issueQueueEnabled: true, scanEnabled: false, autoMerge: false },
      forge,
      runner: { start: async () => process.pid },
      project: { name: 'stub', mergeChecks: () => [], cycleSuite: () => [] },
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
