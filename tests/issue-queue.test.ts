import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildIssueBody, claimIssue, fingerprintOf, issueNumberForTask, parseIssueBody,
  publishFinding, reapStaleLeases, recordIssueForTask,
  LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_READY,
} from '../src/issueQueue.ts'
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

describe('issue body round-trip', () => {
  it('parses what it builds', () => {
    const body = buildIssueBody('[BUG] `src/x/y.ts` does the wrong thing', 'parent-task', 'high')
    const parsed = parseIssueBody(body)
    expect(parsed?.fingerprint).toBe('bug:src/x/y.ts')
    expect(parsed?.effort).toBe('high')
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

    const reaped = await reapStaleLeases(forge, 3, base)
    expect(reaped).toEqual([stale])
    const staleAfter = await forge.getIssue(stale)
    expect(staleAfter.assignees).toEqual([])
    expect(staleAfter.labels).toContain(LABEL_READY)
    const liveAfter = await forge.getIssue(live)
    expect(liveAfter.assignees).toEqual(['worker-busy'])
    expect(liveAfter.labels).toContain(LABEL_IN_PROGRESS)
  })
})

describe('issue map', () => {
  it('records and resolves the task-to-issue mapping', () => {
    recordIssueForTask(paths, 'task-x', 42)
    expect(issueNumberForTask(paths, 'task-x')).toBe(42)
    expect(issueNumberForTask(paths, 'task-unknown')).toBeUndefined()
  })
})

describe('loop integration in issue mode', () => {
  it('publishes findings as issues instead of enqueuing, and claims them back into work', async () => {
    const { execFileSync } = await import('node:child_process')
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
      log: () => {},
      now: () => new Date('2026-08-08T12:00:00Z'),
    })

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
  })
})
