import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Forge, PrStatus } from '../src/adapters/forge.ts'
import { normalizeEntry } from '../src/adapters/forge-github.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig, type LoopConfig } from '../src/config.ts'
import { createLoop, type Loop } from '../src/loop.ts'
import { finalMessageFile, orchPaths, statusFile, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let repoRoot: string
let paths: OrchPaths
let logged: string[]
let forgeStatus: PrStatus
let prStatusCalls: number
let runnerStarts: string[]
let fakeForge: FakeForge

function makeForge(): Forge {
  fakeForge = makeFakeForge()
  fakeForge.prStatus = async () => {
    prStatusCalls += 1
    return forgeStatus
  }
  return fakeForge
}

function makeRunner(): Runner {
  return {
    start: async (options) => {
      runnerStarts.push(options.specFile)
      return process.pid
    },
  }
}

const stubProject: ProjectAdapter = {
  name: 'stub',
  mergeChecks: () => [],
  cycleSuite: () => [],
}

function makeLoop(overrides: Partial<LoopConfig> = {}, project: ProjectAdapter = stubProject): Loop {
  const config = { ...loadConfig({}), ...overrides }
  return createLoop({
    paths,
    config,
    forge: makeForge(),
    runner: makeRunner(),
    project,
    log: (line) => logged.push(line),
    now: () => new Date(2026, 7, 8, 12, 0, 0),
  })
}

function writeFinal(taskId: string, content: string): void {
  writeFileSync(finalMessageFile(paths, taskId), content)
}

function writeRawStatus(taskId: string, status: string, pid: number | null = null): void {
  writeFileSync(statusFile(paths, taskId),
    JSON.stringify({ task_id: taskId, status, pid }))
}

function logText(): string {
  return logged.join('\n')
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-loop-'))
  paths = orchPaths(repoRoot)
  logged = []
  prStatusCalls = 0
  runnerStarts = []
  forgeStatus = { state: 'open', isDraft: true, url: 'https://example.test/pull/1', headSha: '', checks: [] }
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('actionable findings', () => {
  it('filters format placeholders, literal and HTML-encoded, and keeps comparisons', () => {
    const loop = makeLoop()
    writeFinal('t1', [
      'NEXT_TASK: what to fix <and how>',
      'NEXT_TASK: &lt;description&gt;',
      'NEXT_TASK: [BUG] reject a value when count < 0 or count > maximum',
      'NEXT_TASK: [BUG] an ordinary finding',
    ].join('\n'))
    expect(loop.actionableFindings(finalMessageFile(paths, 't1'))).toEqual([
      '[BUG] reject a value when count < 0 or count > maximum',
      '[BUG] an ordinary finding',
    ])
  })

  it('reads only the final message, never the transcript', () => {
    const loop = makeLoop()
    writeFileSync(join(paths.logsDir, 't2.log'), 'NEXT_TASK: [BUG] a fixture in the transcript\n')
    writeFinal('t2', 'done\n')
    expect(loop.actionableFindings(finalMessageFile(paths, 't2'))).toEqual([])
  })

  it('ignores bare markers and trims a normal finding', () => {
    const loop = makeLoop()
    writeFinal('t3', [
      'NEXT_TASK:',
      'NEXT_TASK:   ',
      'NEXT_TASK:   [BUG] an ordinary finding   ',
    ].join('\n'))
    expect(loop.actionableFindings(finalMessageFile(paths, 't3'))).toEqual([
      '[BUG] an ordinary finding',
    ])
  })

  it('ignores descriptions that only report no findings', () => {
    const loop = makeLoop()
    writeFinal('t4', [
      'NEXT_TASK: None.',
      'NEXT_TASK: None. Sections 5 and 6 found no actionable issues.',
      'NEXT_TASK: None for sections 5-6.',
      'NEXT_TASK: Sections 5 and 6 found no actionable issues',
      'NEXT_TASK: nothing to report',
    ].join('\n'))
    expect(loop.actionableFindings(finalMessageFile(paths, 't4'))).toEqual([])
  })

  it('filters a finding that opens with None even when the remainder sounds actionable', () => {
    const loop = makeLoop()
    writeFinal('t-none-prefix', 'NEXT_TASK: None of the export rows carry ids\n')
    expect(loop.actionableFindings(finalMessageFile(paths, 't-none-prefix'))).toEqual([])
  })

  it('keeps findings that describe incorrect no-issue behavior', () => {
    const loop = makeLoop()
    const finding = '[BUG] SearchPage reports no issues when the request fails'
    writeFinal('t-no-issues-bug', `NEXT_TASK: ${finding}\n`)
    expect(loop.actionableFindings(finalMessageFile(paths, 't-no-issues-bug'))).toEqual([finding])
  })

  it('keeps a real finding that contains None', () => {
    const loop = makeLoop()
    const findings = [
      '[BUG] `src/x.ts` returns None instead of an empty list',
      '[TEST] `src/a.ts` covers the None branch',
    ]
    writeFinal('t5', findings.map((finding) => `NEXT_TASK: ${finding}`).join('\n'))
    expect(loop.actionableFindings(finalMessageFile(paths, 't5'))).toEqual(findings)
  })
})

describe('CI check normalization (forge adapter)', () => {
  it('reads completed successes as success', () => {
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('success')
  })
  it('reads an in-progress check with an empty conclusion as pending, never success', () => {
    expect(normalizeEntry({ status: 'IN_PROGRESS', conclusion: '' })).toBe('pending')
  })
  it('reads a completed check with an empty conclusion as pending', () => {
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: '' })).toBe('pending')
  })
  it('reads failures and cancellations as failure', () => {
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('failure')
  })
  it('reads a StatusContext by its state and the unclassifiable as pending', () => {
    expect(normalizeEntry({ state: 'SUCCESS' })).toBe('success')
    expect(normalizeEntry({ state: '' })).toBe('pending')
    expect(normalizeEntry({})).toBe('pending')
  })
})

describe('checkPrCiStatus', () => {
  beforeEach(() => {
    writeFileSync(join(paths.queueDir, 'pr-url.txt'), 'https://example.test/pull/1\n')
  })

  it('passes on all-success and fails on any failure', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [
      { name: 'a', conclusion: 'success' }, { name: 'b', conclusion: 'success' },
    ]
    expect(await loop.checkPrCiStatus()).toBe('success')
    forgeStatus.checks = [{ name: 'a', conclusion: 'failure' }]
    expect(await loop.checkPrCiStatus()).toBe('failure')
  })

  it('keeps waiting on mixed pending and failed checks', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [
      { name: 'a', conclusion: 'pending' }, { name: 'b', conclusion: 'failure' },
    ]
    expect(await loop.checkPrCiStatus()).not.toBe('success')
  })

  it('does not clear the gate for a PR with no checks and no age evidence', async () => {
    const loop = makeLoop()
    forgeStatus.checks = []
    expect(['unknown', 'pending']).toContain(await loop.checkPrCiStatus())
  })

  it('treats a merged PR as passed', async () => {
    const loop = makeLoop()
    forgeStatus = { ...forgeStatus, state: 'merged' }
    expect(await loop.checkPrCiStatus()).toBe('success')
  })
})

describe('scan yield', () => {
  it('records empty for a scan whose transcript had findings but final message none', () => {
    const loop = makeLoop()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '3\n')
    writeFileSync(join(paths.logsDir, '20250101_000000_001_scan.log'),
      'NEXT_TASK: [BUG] an ordinary finding from a displayed fixture\n')
    writeFinal('20250101_000000_001_scan', '')
    loop.recordScanYield('20250101_000000_001_scan')
    expect(readFileSync(join(paths.queueDir, 'scan-yield-3'), 'utf8')).toContain('empty')
  })

  it('recognises the legacy scan-<timestamp> id shape', () => {
    const loop = makeLoop()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '3\n')
    writeFinal('scan-legacy', '')
    loop.recordScanYield('scan-legacy')
    expect(readFileSync(join(paths.queueDir, 'scan-yield-3'), 'utf8')).toContain('empty')
  })

  it('records found for real findings and empty for placeholders', () => {
    const loop = makeLoop()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '3\n')
    writeFinal('20250101_000000_002_scan', 'NEXT_TASK: investigate another issue\n')
    loop.recordScanYield('20250101_000000_002_scan')
    expect(readFileSync(join(paths.queueDir, 'scan-yield-3'), 'utf8')).toContain('found')
    writeFinal('20250101_000000_003_scan', 'NEXT_TASK: &lt;description&gt;\n')
    loop.recordScanYield('20250101_000000_003_scan')
    const lines = readFileSync(join(paths.queueDir, 'scan-yield-3'), 'utf8').trim().split('\n')
    expect(lines[lines.length - 1]).toBe('empty')
  })

  it('records empty when the final message only reports no findings', () => {
    const loop = makeLoop()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '3\n')
    writeFinal('20250101_000000_004_scan', [
      'NEXT_TASK: None.',
      'NEXT_TASK: nothing to report',
    ].join('\n'))
    loop.recordScanYield('20250101_000000_004_scan')
    expect(readFileSync(join(paths.queueDir, 'scan-yield-3'), 'utf8')).toContain('empty')
  })

  it('folds: findings reset the counter, all-empty increments once, no record leaves it alone', () => {
    const loop = makeLoop({ maxEmptyScans: 2 })
    const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')

    writeFileSync(join(paths.queueDir, 'scan-yield-3'), 'found\nempty\n')
    writeFileSync(emptyScanFile, '1\n')
    loop.foldScanYields(3)
    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('0')
    expect(existsSync(join(paths.queueDir, 'scan-yield-3'))).toBe(false)

    writeFileSync(join(paths.queueDir, 'scan-yield-4'), 'empty\nempty\n')
    writeFileSync(emptyScanFile, '1\n')
    loop.foldScanYields(4)
    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('2')

    loop.foldScanYields(5)
    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('2')
  })
})

describe('runAutoReview', () => {
  beforeEach(() => {
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'review-template.md'),
      '# {{REVIEW_ID}} review of cycle {{CYCLE}} against {{BASE_BRANCH}} for {{PR_URL}}\n')
  })

  function lastReviewId(cycle: number): string {
    return readFileSync(join(paths.queueDir, `review-id-${cycle}`), 'utf8').trim()
  }

  it('includes the curated accepted limits in a generated review spec', () => {
    const acceptedLimitsFile = join(HERE, '..', '..', 'accepted-limits.md')
    copyFileSync(join(HERE, '..', '..', 'templates', 'review-template.md'),
      join(paths.root, 'templates', 'review-template.md'))
    copyFileSync(acceptedLimitsFile, join(paths.root, 'accepted-limits.md'))

    expect(makeLoop().runAutoReview(7, false)).toBe(false)
    const spec = readFileSync(join(paths.tasksDir, `${lastReviewId(7)}.md`), 'utf8')
    expect(spec).toContain(readFileSync(acceptedLimitsFile, 'utf8').trim())
    expect(spec).not.toContain('{{ACCEPTED_LIMITS}}')
  })

  it('marks accepted limits as none when the file is missing', () => {
    copyFileSync(join(HERE, '..', '..', 'templates', 'review-template.md'),
      join(paths.root, 'templates', 'review-template.md'))

    expect(makeLoop().runAutoReview(7, false)).toBe(false)
    const spec = readFileSync(join(paths.tasksDir, `${lastReviewId(7)}.md`), 'utf8')
    expect(spec).toContain('## Accepted limits')
    expect(spec).toContain('(none)')
    expect(spec).not.toContain('{{ACCEPTED_LIMITS}}')
  })

  it('dispatches a review on first entry and resumes after a clean one', () => {
    const loop = makeLoop({ reviewEffort: 'low' })
    expect(loop.runAutoReview(7, false)).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'review-round-7'), 'utf8').trim()).toBe('1')
    const reviewId = lastReviewId(7)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toContain(reviewId)
    expect(readFileSync(join(paths.queueDir, 'effort', reviewId), 'utf8').trim()).toBe('low')

    writeRawStatus(reviewId, 'completed')
    writeFinal(reviewId, '')
    expect(loop.runAutoReview(7, false)).toBe(true)
  })

  it('does not let a placeholder finding hold the gate open', () => {
    const loop = makeLoop()
    expect(loop.runAutoReview(10, false)).toBe(false)
    const reviewId = lastReviewId(10)
    writeRawStatus(reviewId, 'completed')
    writeFinal(reviewId, 'NEXT_TASK: what to fix <and how>\n')
    expect(loop.runAutoReview(10, false)).toBe(true)
  })

  it('sends the cycle round again on findings, with a fresh review id', () => {
    const loop = makeLoop()
    expect(loop.runAutoReview(8, false)).toBe(false)
    const first = lastReviewId(8)
    writeRawStatus(first, 'completed')
    writeFinal(first, 'NEXT_TASK: [BUG] something the diff broke\n')
    expect(loop.runAutoReview(8, false)).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'review-round-8'), 'utf8').trim()).toBe('2')
    expect(lastReviewId(8)).not.toBe(first)
  })

  it('resumes at the round limit instead of reviewing the same diff forever', () => {
    const loop = makeLoop()
    loop.runAutoReview(8, false)
    let reviewId = lastReviewId(8)
    writeRawStatus(reviewId, 'completed')
    writeFinal(reviewId, 'NEXT_TASK: [BUG] something the diff broke\n')
    loop.runAutoReview(8, false)
    reviewId = lastReviewId(8)
    writeRawStatus(reviewId, 'completed')
    writeFinal(reviewId, 'NEXT_TASK: [BUG] still not happy\n')
    expect(loop.runAutoReview(8, false)).toBe(true)
    expect(logText()).toContain('after 2 rounds')
  })

  it('resumes without a verdict when the review crashed', () => {
    const loop = makeLoop()
    loop.runAutoReview(9, false)
    const reviewId = lastReviewId(9)
    writeRawStatus(reviewId, 'failed')
    expect(loop.runAutoReview(9, false)).toBe(true)
    expect(logText()).toContain('resuming without its verdict')
  })

  it('skips off-cadence cycles and reviews on-cadence ones', () => {
    const loop = makeLoop({ reviewEveryNCycles: 2 })
    expect(loop.runAutoReview(3, false)).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-3'))).toBe(false)
    expect(loop.runAutoReview(4, false)).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-4'))).toBe(true)
  })

  it('reviews the final cycle past the normal cap and stops when it never converges', () => {
    const loop = makeLoop({ reviewEveryNCycles: 2, maxReviewRounds: 2, maxFinalReviewRounds: 4 })
    // The state the bash test builds: round 2 done, and the previous review found things.
    writeFileSync(join(paths.queueDir, 'review-round-5'), '2\n')
    writeFileSync(join(paths.queueDir, 'review-id-5'), 'prev-review-c5\n')
    writeRawStatus('prev-review-c5', 'completed')
    writeFinal('prev-review-c5', 'NEXT_TASK: [BUG] found late\n')
    const stopFile = join(paths.queueDir, 'stop')
    rmSync(stopFile, { force: true })
    expect(loop.runAutoReview(5, true)).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'review-round-5'), 'utf8').trim()).toBe('3')
    expect(existsSync(stopFile)).toBe(false)

    writeFileSync(join(paths.queueDir, 'review-round-5'), '4\n')
    const last = lastReviewId(5)
    writeRawStatus(last, 'completed')
    writeFinal(last, 'NEXT_TASK: [BUG] still found\n')
    expect(loop.runAutoReview(5, true)).toBe(false)
    expect(existsSync(stopFile)).toBe(true)
  })
})

describe('cycleIsFinal', () => {
  it('marks the scan-limit cycle and the empty-threshold cycle, not an ordinary one', () => {
    const loop = makeLoop({ maxScanCycles: 6, maxEmptyScans: 2 })
    expect(loop.cycleIsFinal(6)).toBe(true)
    expect(loop.cycleIsFinal(3)).toBe(false)
    writeFileSync(join(paths.queueDir, 'scan-yield-3'), 'empty\nempty\n')
    writeFileSync(join(paths.queueDir, 'empty-scan-count.txt'), '1\n')
    expect(loop.cycleIsFinal(3)).toBe(true)
  })
})

describe('remote issue queue idle detection', () => {
  beforeEach(() => {
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'review-template.md'),
      '# {{REVIEW_ID}} review of cycle {{CYCLE}} against {{BASE_BRANCH}} for {{PR_URL}}\n')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
  })

  function makeReviewLoop(issueQueueEnabled: boolean): Loop {
    return makeLoop({
      issueQueueEnabled,
      autoPr: false,
      reviewEnabled: true,
      autoReview: true,
    })
  }

  it('defers the cycle gate and review while a ready issue is open', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'pending fix',
      body: '',
      labels: ['loop:ready', 'loop:in-progress'],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toContain('Waiting for 1 remote issue-queue task')
  })

  it('defers the cycle gate and review while an in-progress issue is open', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({ title: 'claimed fix', body: '', labels: ['loop:in-progress'] })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toContain('Waiting for 1 remote issue-queue task')
  })

  it('enters the gate and dispatches the review when no remote issue is open', async () => {
    const loop = makeReviewLoop(true)

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })

  it('never consults the forge when the issue queue is disabled', async () => {
    const loop = makeReviewLoop(false)
    fakeForge.listOpenIssues = async () => {
      throw new Error('forge should not be consulted')
    }

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })
})

describe('collectDecisions', () => {
  const decisionsFile = (): string => join(paths.queueDir, 'decisions.txt')
  const countDecisions = (): number =>
    readFileSync(decisionsFile(), 'utf8').split('\n').filter((line) => line !== '').length

  it('records a decision, not the NEXT_TASK next to it, and never twice', () => {
    const loop = makeLoop()
    writeFinal('d1', [
      'NEXT_TASK: [BUG] an ordinary finding',
      'DECISION_REQUIRED: react-router 7 to 8 fixes CVE-2026-22030; the RSC path is unreachable here',
    ].join('\n'))
    loop.collectDecisions('d1')
    expect(countDecisions()).toBe(1)
    expect(readFileSync(decisionsFile(), 'utf8')).toContain('react-router 7 to 8')
    loop.collectDecisions('d1')
    expect(countDecisions()).toBe(1)
  })

  it('folds one advisory worded three ways into one decision', () => {
    const loop = makeLoop()
    writeFinal('d2', [
      'DECISION_REQUIRED: Dependabot alert #1 (high, GHSA-qwww-vcr4-c8h2) affects react-router 7.18.2 and is patched only in 8.3.0',
      'DECISION_REQUIRED: Dependabot alert #1 reports high-severity [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) in `react-router` 7.18.2',
      'DECISION_REQUIRED: [SECURITY] Dependabot #1 (ghsa-qwww-vcr4-c8h2) affects `react-router` 7.18.2; the unstable RSC path is unreachable',
    ].join('\n'))
    loop.collectDecisions('d2')
    expect(countDecisions()).toBe(1)

    writeFinal('d3', 'DECISION_REQUIRED: Dependabot alert #2 (high, GHSA-aaaa-bbbb-cccc) affects react-router 7.18.2 and is patched only in 8.3.0\n')
    loop.collectDecisions('d3')
    expect(countDecisions()).toBe(2)
  })

  it('matches CVE identifiers case-insensitively', () => {
    const loop = makeLoop()
    writeFinal('d4', [
      'DECISION_REQUIRED: CVE-2026-22030 needs the major upgrade',
      'DECISION_REQUIRED: the fix for cve-2026-22030 crosses a major version',
    ].join('\n'))
    loop.collectDecisions('d4')
    expect(countDecisions()).toBe(1)
  })

  it('falls back to whole-line matching without an identifier', () => {
    const loop = makeLoop()
    writeFinal('d5', [
      'DECISION_REQUIRED: adopt the new expense model or keep the current one',
      'DECISION_REQUIRED: adopt the new expense model or keep the current one',
      'DECISION_REQUIRED: drop the legacy artist link or migrate it',
    ].join('\n'))
    loop.collectDecisions('d5')
    expect(countDecisions()).toBe(2)
  })

  it('ignores the template format example', () => {
    const loop = makeLoop()
    writeFinal('d6', 'DECISION_REQUIRED: what the choice is <and what it costs>\n')
    loop.collectDecisions('d6')
    expect(existsSync(decisionsFile())).toBe(false)
  })

  it('ignores a bare decision marker', () => {
    const loop = makeLoop()
    writeFinal('d7', 'DECISION_REQUIRED:\n')
    loop.collectDecisions('d7')
    expect(existsSync(decisionsFile())).toBe(false)
  })
})

describe('failure announcement and burst stop (via poll)', () => {
  it('includes the current scan cycle in the per-poll status line', async () => {
    const loop = makeLoop({ scanEnabled: false, maxScanCycles: 6 })

    expect(await loop.poll()).toBe('continue')
    expect(logText()).toMatch(/\| Cycle=\d+\/\d+ Running=/)
  })

  it('announces a failure once, records it for the cycle, and stops on a burst', async () => {
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 3 })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
    for (const taskId of ['f1', 'f2', 'f3']) {
      writeRawStatus(taskId, 'running', null)
    }

    expect(await loop.poll()).toBe('continue')
    for (const taskId of ['f1', 'f2', 'f3']) {
      expect(logText()).toContain(`[loop] FAILED: ${taskId}`)
    }
    const failedRecord = readFileSync(join(paths.queueDir, 'failed-4'), 'utf8')
    expect(failedRecord.trim().split('\n')).toHaveLength(3)
    expect(logText()).toContain('environment failure')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)

    // The next poll consumes the stop and exits; the failures are not announced again.
    logged = []
    expect(await loop.poll()).toBe('stopped')
    expect(logText()).not.toContain('FAILED: f1')
    expect(readFileSync(join(paths.queueDir, 'failed-4'), 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('records a failed scan in its cycle before entering the cycle gate', async () => {
    const taskId = '20260809_000000_001_scan'
    const loop = makeLoop({
      autoPr: false,
      reviewEnabled: true,
      autoReview: false,
    })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeRawStatus(taskId, 'failed')

    expect(await loop.poll()).toBe('continue')

    expect(readFileSync(join(paths.queueDir, 'failed-1'), 'utf8')).toBe(`${taskId}\n`)
    expect(logged.indexOf(`[loop] FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`))
      .toBeLessThan(logged.findIndex((line) => line.includes('CYCLE_COMPLETE: 1/')))
  })

  it('does not start queued work or scans while a stop is pending', async () => {
    const loop = makeLoop({ autoMerge: false, scanEnabled: true, maxBurstFailures: 1 })
    writeRawStatus('f1', 'running', null)
    writeFileSync(join(paths.tasksDir, 'queued-task.md'), '# spec\n')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), 'queued-task:0\n')

    await loop.poll()
    expect(runnerStarts).toHaveLength(0)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toContain('queued-task')
  })
})

describe('noteMergeFailure', () => {
  const mergeLog = (): string => join(paths.logsDir, 'sample.merge.log')
  const stopFile = (): string => join(paths.queueDir, 'stop')

  it('names Docker, counts to the limit, and stops', () => {
    const loop = makeLoop({ maxConsecutiveMergeFailures: 3 })
    writeFileSync(mergeLog(), 'Caused by: java.lang.IllegalStateException: Could not find a valid Docker environment. Please see logs\n')
    loop.noteMergeFailure(mergeLog())
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('1')
    expect(logText()).toContain('Docker is not running')
    expect(existsSync(stopFile())).toBe(false)

    loop.noteMergeFailure(mergeLog())
    expect(existsSync(stopFile())).toBe(false)
    loop.noteMergeFailure(mergeLog())
    expect(existsSync(stopFile())).toBe(true)
    expect(logText()).toContain('nothing is landing')
  })

  it('restarts the count after a successful merge cleared it', () => {
    const loop = makeLoop({ maxConsecutiveMergeFailures: 3 })
    writeFileSync(mergeLog(), 'whatever\n')
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '0\n')
    loop.noteMergeFailure(mergeLog())
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('1')
    expect(existsSync(stopFile())).toBe(false)
  })

  it('does not blame the environment for an ordinary test failure', () => {
    const loop = makeLoop()
    writeFileSync(mergeLog(), 'Tests run: 4, Failures: 1\nTests failed. Aborting merge.\n')
    loop.noteMergeFailure(mergeLog())
    expect(logText()).not.toMatch(/Docker is not running|unreachable/)
  })

  it('recognises the unreachable-registry signature', () => {
    const loop = makeLoop()
    writeFileSync(mergeLog(), 'Could not transfer artifact org.example:thing from central\n')
    loop.noteMergeFailure(mergeLog())
    expect(logText()).toContain('unreachable')
  })
})

describe('runCycleSuite', () => {
  const stopFile = (): string => join(paths.queueDir, 'stop')

  it('is a no-op under full task gates', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{ label: 'Marker', cwd: '', command: 'touch suite-ran' }],
    }
    const loop = makeLoop({ taskGate: 'full' }, suiteProject)
    expect(loop.runCycleSuite(1)).toBe(true)
    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(false)
  })

  it('runs the project suite under light gates and continues on a pass', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{ label: 'Marker', cwd: '', command: 'touch suite-ran' }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(1)).toBe(true)
    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(true)
    expect(existsSync(stopFile())).toBe(false)
  })

  it('stops the loop rather than promote a failing tip', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{ label: 'Failing', cwd: '', command: 'echo "Tests run: 4, Failures: 1"; exit 1' }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(2)).toBe(false)
    expect(existsSync(stopFile())).toBe(true)
    expect(logText()).toContain('stopping rather than promoting a failing tip')
  })

  it('attributes a tool-not-found failure to the environment, not the branch', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Broken toolchain', cwd: '',
        command: 'echo "vitest is not recognized as an internal or external command"; exit 1',
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(5)).toBe(false)
    expect(logText()).toContain('the environment broke, not the branch')
    expect(existsSync(stopFile())).toBe(true)
  })

  it('runs the repair when its marker path is missing and skips it when present', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Repairable', cwd: '', command: 'touch suite-ran',
        repairWhenMissing: { path: 'launcher-shim', command: 'touch repaired', message: 'the launcher is missing' },
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(3)).toBe(true)
    expect(existsSync(join(repoRoot, 'repaired'))).toBe(true)

    rmSync(join(repoRoot, 'repaired'))
    writeFileSync(join(repoRoot, 'launcher-shim'), '')
    expect(loop.runCycleSuite(4)).toBe(true)
    expect(existsSync(join(repoRoot, 'repaired'))).toBe(false)
  })

  it('skips a step whose required path is absent', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{ label: 'Absent', cwd: 'nowhere', command: 'exit 1', requires: 'nowhere' }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)
    expect(loop.runCycleSuite(6)).toBe(true)
  })
})

describe('scanForNextTasks', () => {
  beforeEach(() => {
    mkdirSync(join(paths.root, 'templates', 'pitfalls'), { recursive: true })
    const realPitfalls = join(HERE, '..', '..', 'templates', 'pitfalls')
    for (const name of readdirSync(realPitfalls)) {
      copyFileSync(join(realPitfalls, name), join(paths.root, 'templates', 'pitfalls', name))
    }
    writeFileSync(join(paths.root, 'templates', 'task-requirements.md'), 'Shared requirements.\n')
  })

  it('gives a review-spawned fix high effort and the code pitfall list', async () => {
    const loop = makeLoop()
    writeFinal('20250101_000000_010_review-c1', 'NEXT_TASK: [BUG] a defect a review found\n')
    await loop.scanForNextTasks('20250101_000000_010_review-c1', 0)

    const specs = readdirSync(paths.tasksDir)
    expect(specs).toHaveLength(1)
    const fixId = (specs[0] as string).replace(/\.md$/, '')
    expect(readFileSync(join(paths.queueDir, 'effort', fixId), 'utf8').trim()).toBe('high')
    expect(readFileSync(join(paths.tasksDir, `${fixId}.md`), 'utf8')).toContain('Stale async responses')
  })

  it('combines several findings from one review into one high-effort fix task', async () => {
    const loop = makeLoop()
    writeFinal('20250101_000000_013_review-c1', [
      'NEXT_TASK: [BUG] guard the stale response',
      'NEXT_TASK: [BUG] preserve zero in the numeric input',
      'NEXT_TASK: [TEST] cover the slow list load',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_013_review-c1', 0)

    const specs = readdirSync(paths.tasksDir)
    expect(specs).toHaveLength(1)
    const fixId = (specs[0] as string).replace(/\.md$/, '')
    const descIndexes = readdirSync(join(paths.queueDir, 'desc-index'))
    expect(descIndexes).toHaveLength(4)
    expect(descIndexes.every((name) => name.startsWith('auto-'))).toBe(true)
    expect(descIndexes.map((name) =>
      readFileSync(join(paths.queueDir, 'desc-index', name), 'utf8').trim()))
      .toEqual([fixId, fixId, fixId, fixId])
    const spec = readFileSync(join(paths.tasksDir, `${fixId}.md`), 'utf8')
    expect(spec).toContain('## Requirement\n\n1. [BUG] guard the stale response')
    expect(spec).toContain('2. [BUG] preserve zero in the numeric input')
    expect(spec).toContain('3. [TEST] cover the slow list load')
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8').trim().split('\n')).toEqual([
      `${fixId}:1`,
    ])
    expect(readFileSync(join(paths.queueDir, 'effort', fixId), 'utf8').trim()).toBe('high')
  })

  it('combines only review findings that are not already queued individually', async () => {
    const loop = makeLoop()
    const queued = '[BUG] `src/already.ts` was already queued'
    writeFinal('20250101_000000_020_scan', `NEXT_TASK: ${queued}\n`)
    await loop.scanForNextTasks('20250101_000000_020_scan', 0)

    writeFinal('20250101_000000_021_review-c1', [
      `NEXT_TASK: ${queued}`,
      'NEXT_TASK: [BUG] `src/new-a.ts` needs a fix',
      'NEXT_TASK: [TEST] `src/new-b.test.ts` needs coverage',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_021_review-c1', 0)

    const specs = readdirSync(paths.tasksDir).map((name) =>
      readFileSync(join(paths.tasksDir, name), 'utf8'))
    expect(specs).toHaveLength(2)
    const aggregate = specs.find((spec) => spec.includes('1. [BUG] `src/new-a.ts`'))
    expect(aggregate).toContain('2. [TEST] `src/new-b.test.ts` needs coverage')
    expect(aggregate).not.toContain(queued)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8').trim().split('\n'))
      .toHaveLength(2)
  })

  it('keeps several scan findings as separate tasks', async () => {
    const loop = makeLoop()
    writeFinal('20250101_000000_014_scan', [
      'NEXT_TASK: [BUG] first scan finding',
      'NEXT_TASK: [BUG] second scan finding',
      'NEXT_TASK: [TEST] third scan finding',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_014_scan', 0)

    expect(readdirSync(paths.tasksDir)).toHaveLength(3)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('files several review findings as one high-effort issue', async () => {
    const loop = makeLoop({ issueQueueEnabled: true })
    const parentId = '20250101_000000_015_review-c1'
    writeFinal(parentId, [
      'NEXT_TASK: [BUG] guard the stale response',
      'NEXT_TASK: [BUG] preserve zero in the numeric input',
      'NEXT_TASK: [TEST] cover the slow list load',
    ].join('\n'))
    await loop.scanForNextTasks(parentId, 0)

    expect(fakeForge.issues.size).toBe(1)
    const issue = [...fakeForge.issues.values()][0]
    expect(issue?.title).toBe(`Review round fixes (${parentId})`)
    expect(issue?.body).toContain('Effort: high')
    expect(issue?.body).toContain('## Requirement\n\n1. [BUG] guard the stale response')
    expect(issue?.body).toContain('2. [BUG] preserve zero in the numeric input')
    expect(issue?.body).toContain('3. [TEST] cover the slow list load')
  })

  it('filters an open advisory before aggregating the other review findings', async () => {
    const loop = makeLoop({ issueQueueEnabled: true })
    writeFinal('20250101_000000_022_scan',
      'NEXT_TASK: [BUG] CVE-2026-22030 remains open\n')
    await loop.scanForNextTasks('20250101_000000_022_scan', 0)

    writeFinal('20250101_000000_023_review-c1', [
      'NEXT_TASK: [SECURITY] Different wording for CVE-2026-22030',
      'NEXT_TASK: [BUG] `src/new-a.ts` needs a fix',
      'NEXT_TASK: [TEST] `src/new-b.test.ts` needs coverage',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_023_review-c1', 0)

    expect(fakeForge.issues.size).toBe(2)
    const aggregate = await fakeForge.getIssue(2)
    expect(aggregate.body).not.toContain('Different wording for CVE-2026-22030')
    expect(aggregate.body).toContain('1. [BUG] `src/new-a.ts` needs a fix')
    expect(aggregate.body).toContain('2. [TEST] `src/new-b.test.ts` needs coverage')
    expect(aggregate.body.match(/^Fingerprint: /gm)).toHaveLength(2)

    writeFinal('20250101_000000_024_review-c1',
      'NEXT_TASK: [TEST] `src/new-b.test.ts` needs coverage\n')
    await loop.scanForNextTasks('20250101_000000_024_review-c1', 0)
    expect(fakeForge.issues.size).toBe(2)
  })

  it('files several scan findings as separate issues', async () => {
    const loop = makeLoop({ issueQueueEnabled: true })
    writeFinal('20250101_000000_016_scan', [
      'NEXT_TASK: [BUG] first scan finding',
      'NEXT_TASK: [BUG] second scan finding',
      'NEXT_TASK: [TEST] third scan finding',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_016_scan', 0)

    expect([...fakeForge.issues.values()].map((issue) => issue.title)).toEqual([
      '[BUG] first scan finding',
      '[BUG] second scan finding',
      '[TEST] third scan finding',
    ])
  })

  it('writes specs that instruct the completion marker — its absence records finished work as failed', async () => {
    const loop = makeLoop()
    writeFinal('20250101_000000_012_scan', 'NEXT_TASK: [BUG] a finding whose fix must be detectable\n')
    await loop.scanForNextTasks('20250101_000000_012_scan', 0)
    const specs = readdirSync(paths.tasksDir)
    const spec = readFileSync(join(paths.tasksDir, specs[0] as string), 'utf8')
    expect(spec).toContain('TASK_COMPLETE')
    expect(spec).toMatch(/## Commit/)
  })

  it('gives a scan-spawned test task no override and the tests pitfall list', async () => {
    const loop = makeLoop()
    writeFinal('20250101_000000_011_scan', 'NEXT_TASK: [TEST] a coverage gap a scan found\n')
    await loop.scanForNextTasks('20250101_000000_011_scan', 0)

    const specs = readdirSync(paths.tasksDir)
    expect(specs).toHaveLength(1)
    const testId = (specs[0] as string).replace(/\.md$/, '')
    expect(existsSync(join(paths.queueDir, 'effort', testId))).toBe(false)
    expect(readFileSync(join(paths.tasksDir, `${testId}.md`), 'utf8')).toContain('clearAllMocks keeps implementations')
  })

  it('bounds growth by depth and by total task count', async () => {
    const loop = makeLoop({ maxGrowthDepth: 1 })
    writeFinal('deep-parent', 'NEXT_TASK: [BUG] too deep\n')
    await loop.scanForNextTasks('deep-parent', 1)
    expect(readdirSync(paths.tasksDir)).toHaveLength(0)
    expect(logText()).toContain('Growth depth limit reached')
  })

  it('re-admits a review finding whose indexed task failed, and suppresses landed ones', async () => {
    const loop = makeLoop()
    const finding = '[BUG] a defect whose first fix crashed'

    writeFinal('20250101_000000_020_review-c1', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_020_review-c1', 0)
    const specs = readdirSync(paths.tasksDir)
    expect(specs).toHaveLength(1)
    const taskId = (specs[0] as string).replace(/\.md$/, '')

    // The first attempt failed: the finding must come back as retryable work.
    writeRawStatus(taskId, 'failed')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    logged = []
    writeFinal('20250101_000000_021_review-c1', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_021_review-c1', 0)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toContain(taskId)
    expect(logText()).not.toContain('Duplicate finding')

    // Once the fix landed, the same finding is suppressed as a duplicate.
    writeRawStatus(taskId, 'merged')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    logged = []
    writeFinal('20250101_000000_022_review-c1', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_022_review-c1', 0)
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8')).toBe('')
    expect(logText()).toContain(`Duplicate finding, existing task ${taskId}`)
  })
})
