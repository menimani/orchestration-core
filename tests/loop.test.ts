import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Forge, PrStatus } from '../src/adapters/forge.ts'
import { normalizeEntry } from '../src/adapters/forge-github.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig, type LoopConfig } from '../src/config.ts'
import {
  buildIssueBody, recordIssueForTask, recordIssuePromotion, LABEL_FINDING, LABEL_IN_PROGRESS,
  LABEL_READY,
} from '../src/issueQueue.ts'
import { existingTaskIdForDesc, recordTaskIdForDesc } from '../src/ids.ts'
import { createLoop, formatEventLine, type Loop } from '../src/loop.ts'
import {
  syncOrchestrationDepsAtStartup, type OrchestrationDepsRuntime,
} from '../src/merge.ts'
import {
  branchName, finalMessageFile, orchPaths, statusFile, worktreeDir, type OrchPaths,
} from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let repoRoot: string
let paths: OrchPaths
let logged: string[]
let forgeStatus: PrStatus
let prStatusCalls: number
let runnerStarts: string[]
let fakeForge: FakeForge

describe('formatEventLine', () => {
  it('pads subjects to a fixed column and separates longer subjects', () => {
    expect(formatEventLine('Claimed', '064_auto', '#349')).toBe('Claimed 064_auto    #349')
    expect(formatEventLine('Started', '227_review', 'effort medium'))
      .toBe('Started 227_review  effort medium')
    expect(formatEventLine('Failed', 'subject-over-12', 'log task.log'))
      .toBe('Failed subject-over-12  log task.log')
  })

  it('does not add trailing padding without a detail', () => {
    expect(formatEventLine('Completed')).toBe('Completed')
    expect(formatEventLine('Completed', '064_auto')).toBe('Completed 064_auto')
  })
})

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

function makeLoop(
  overrides: Partial<LoopConfig> = {},
  project: ProjectAdapter = stubProject,
  orchestrationDepsRuntime?: OrchestrationDepsRuntime,
  clock: () => Date = () => new Date(2026, 7, 8, 12, 0, 0),
  runner: Runner = makeRunner(),
): Loop {
  const config = { ...loadConfig({}), ...overrides }
  return createLoop({
    paths,
    config,
    forge: makeForge(),
    runner,
    project,
    log: (line) => logged.push(line),
    now: clock,
    orchestrationDepsRuntime,
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

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function initializeGitRepo(): string {
  git(['init', '--initial-branch=main'])
  git(['config', 'user.email', 'loop-test@example.test'])
  git(['config', 'user.name', 'Loop Test'])
  writeFileSync(join(repoRoot, 'tracked.txt'), 'initial\n')
  git(['add', 'tracked.txt'])
  git(['commit', '-m', 'initial'])
  return git(['rev-parse', 'HEAD'])
}

function makeCompletedTask(taskId: string, writeCompletedStatus = true): void {
  writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
  const worktree = worktreeDir(paths, taskId)
  git(['worktree', 'add', worktree, '-b', branchName(taskId)])
  writeFileSync(join(worktree, `${taskId}.txt`), 'completed work\n')
  execFileSync('git', ['add', '-A'], { cwd: worktree })
  execFileSync('git', ['commit', '-qm', 'fix: complete fixture task'], { cwd: worktree })
  writeFinal(taskId, 'TASK_COMPLETE\n')
  if (writeCompletedStatus) writeRawStatus(taskId, 'completed')
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

describe('daemon startup', () => {
  function writeOrchestrationManifests(lockVersion: string): void {
    mkdirSync(join(repoRoot, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(repoRoot, 'orchestration', 'ts', 'package.json'), JSON.stringify({
      dependencies: { zod: '^4.4.3' },
    }))
    writeFileSync(join(repoRoot, 'orchestration', 'ts', 'package-lock.json'), lockVersion)
  }

  function successfulInstall(): void {
    const packageDir = join(repoRoot, 'orchestration', 'ts', 'node_modules', 'zod')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), '{}\n')
  }

  it('records the installed lockfile and skips a synchronized restart', () => {
    writeOrchestrationManifests('{"lockfileVersion":3}\n')
    const install = vi.fn(successfulInstall)
    syncOrchestrationDepsAtStartup(
      paths,
      (name, subject) => logged.push(`${name} ${subject}`),
      { install },
    )

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(join(repoRoot, 'orchestration', 'ts'))
    expect(logged).toContain('Installed  orchestration deps  at startup')

    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install })

    expect(install).toHaveBeenCalledOnce()
  })

  it('reinstalls after a lockfile change and retries a failed upgrade on restart', () => {
    writeOrchestrationManifests('{"lockfileVersion":3}\n')
    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install: successfulInstall })
    writeFileSync(
      join(repoRoot, 'orchestration', 'ts', 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"node_modules/zod":{"version":"4.5.0"}}}\n',
    )
    const failedInstall = vi.fn(() => { throw new Error('registry unavailable') })

    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install: failedInstall })
    syncOrchestrationDepsAtStartup(paths, vi.fn(), { install: failedInstall })

    expect(failedInstall).toHaveBeenCalledTimes(2)
  })
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

  it('treats NO_FINDINGS as an explicit empty result', () => {
    const loop = makeLoop()
    writeFinal('t-no-findings', 'NO_FINDINGS\n')

    expect(loop.actionableFindings(finalMessageFile(paths, 't-no-findings'))).toEqual([])
    expect(logged).toEqual([])
  })

  it('keeps a real finding and warns when NO_FINDINGS contradicts it', () => {
    const loop = makeLoop()
    const finding = '[BUG] `src/search.ts` drops valid results'
    writeFinal('t-contradiction', `NO_FINDINGS\nNEXT_TASK: ${finding}\n`)

    expect(loop.actionableFindings(finalMessageFile(paths, 't-contradiction'))).toEqual([finding])
    expect(logText()).toContain('WARN final message has NO_FINDINGS and NEXT_TASK')
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

  it('ignores Japanese descriptions that only report no findings', () => {
    const loop = makeLoop()
    const phrases = [
      '\u6307\u6458\u306a\u3057',
      '\u554f\u984c\u306a\u3057',
      '\u8a72\u5f53\u306a\u3057',
      '\u7279\u306b\u306a\u3057',
      '\u306a\u3057',
    ]
    const findings = phrases.flatMap((phrase) => [phrase, `${phrase}\u3002`])
    writeFinal('t4-ja', findings.map((finding) => `NEXT_TASK: ${finding}`).join('\n'))

    expect(loop.actionableFindings(finalMessageFile(paths, 't4-ja'))).toEqual([])
    expect(logged).toEqual([])
  })

  it('warns and ignores a finding whose description cannot produce a task slug', () => {
    const loop = makeLoop()
    const finding = '\u8a2d\u5b9a\u753b\u9762\u304c\u958b\u3051\u306a\u3044'
    writeFinal('t-empty-slug', `NEXT_TASK: ${finding}\n`)

    expect(loop.actionableFindings(finalMessageFile(paths, 't-empty-slug'))).toEqual([])
    expect(logText()).toContain(`WARN ignored finding with an empty slug: ${finding}`)
  })

  it('keeps a normal English finding after applying the slug guard', () => {
    const loop = makeLoop()
    const finding = '[BUG] `src/search.ts` mishandles an empty response'
    writeFinal('t-english-slug', `NEXT_TASK: ${finding}\n`)

    expect(loop.actionableFindings(finalMessageFile(paths, 't-english-slug'))).toEqual([finding])
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
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipped')
  })
  it('reads an in-progress check with an empty conclusion as pending, never success', () => {
    expect(normalizeEntry({ status: 'IN_PROGRESS', conclusion: '' })).toBe('pending')
  })
  it('reads a completed check with an empty conclusion as pending', () => {
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: '' })).toBe('pending')
  })
  it('reads terminal unsuccessful conclusions as failure', () => {
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' })).toBe('failure')
    expect(normalizeEntry({ status: 'COMPLETED', conclusion: 'STALE' })).toBe('failure')
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
      { name: 'a', conclusion: 'success', startedAt: '' },
      { name: 'b', conclusion: 'success', startedAt: '' },
    ]
    expect(await loop.checkPrCiStatus()).toBe('success')
    forgeStatus.checks = [{ name: 'a', conclusion: 'failure', startedAt: '' }]
    expect(await loop.checkPrCiStatus()).toBe('failure')
  })

  it('keeps waiting on mixed pending and failed checks', async () => {
    const loop = makeLoop()
    forgeStatus.checks = [
      { name: 'a', conclusion: 'pending', startedAt: '' },
      { name: 'b', conclusion: 'failure', startedAt: '' },
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

  it('records empty when the final message uses NO_FINDINGS', () => {
    const loop = makeLoop()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '3\n')
    writeFinal('20250101_000000_005_scan', 'NO_FINDINGS\n')

    loop.recordScanYield('20250101_000000_005_scan')

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

  it('resumes after a review reports NO_FINDINGS', () => {
    const loop = makeLoop()
    expect(loop.runAutoReview(7, false)).toBe(false)
    const reviewId = lastReviewId(7)
    writeRawStatus(reviewId, 'completed')
    writeFinal(reviewId, 'NO_FINDINGS\n')

    expect(loop.runAutoReview(7, false)).toBe(true)
    expect(logText()).toBe('')
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
    expect(logText()).toContain('WARN review 001_review ended failed without a verdict')
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

  it('logs changed remote work immediately and unchanged work at most every ten minutes', async () => {
    let current = new Date(2026, 7, 8, 12, 0, 0)
    const loop = makeLoop({
      issueQueueEnabled: true,
      autoPr: false,
      reviewEnabled: true,
      autoReview: true,
    }, stubProject, undefined, () => current)
    await fakeForge.createIssue({
      title: 'pending fix',
      body: '',
      labels: ['loop:ready', 'loop:in-progress'],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logged).toEqual(['Waiting remote  issues #1'])

    await loop.triggerScanIfIdle()
    expect(logged).toHaveLength(1)

    await fakeForge.createIssue({
      title: 'another pending fix', body: '', labels: ['loop:in-progress'],
    })
    await loop.triggerScanIfIdle()
    expect(logged.at(-1)).toBe('Waiting remote  issues #1 #2')

    current = new Date(2026, 7, 8, 12, 9, 59)
    await loop.triggerScanIfIdle()
    expect(logged).toHaveLength(2)
    current = new Date(2026, 7, 8, 12, 10, 0)
    await loop.triggerScanIfIdle()
    expect(logged.at(-1)).toBe('Waiting remote  issues #1 #2')
    expect(logged).toHaveLength(3)
  })

  it('defers the cycle gate and review while an in-progress issue is open', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({ title: 'claimed fix', body: '', labels: ['loop:in-progress'] })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toBe('Waiting remote  issues #1')
  })

  it('defers the cycle gate and review while a merge-failed issue is open', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({ title: 'adoption needs repair', body: '', labels: ['loop:merge-failed'] })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toBe('Waiting remote  issues #1')
  })

  it('defers the cycle gate and review when remote issue listing fails', async () => {
    const loop = makeReviewLoop(true)
    fakeForge.listOpenIssues = async () => {
      throw new Error('forge unavailable')
    }

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toContain('WARN could not count remote issue work: forge unavailable')
  })

  it('enters the gate when an in-progress issue has a local promotion record', async () => {
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'locally merged fix', body: '', labels: ['loop:in-progress'],
    })
    recordIssueForTask(paths, 'merged-task', issueNumber)
    recordIssuePromotion(paths, 'merged-task', 'abc123', 'feature/run-9')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })

  it('enters the gate when a forge-visible merge marker names an ancestor of HEAD', async () => {
    const mergeSha = initializeGitRepo()
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'remotely merged fix', body: '', labels: ['loop:in-progress'],
    })
    await fakeForge.commentIssue(
      issueNumber,
      `MERGED: remote-task\nMerged as ${mergeSha} into run branch feature/run-9. This issue closes on promotion.`,
    )

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })

  it('does not exempt a merge marker whose SHA is not an ancestor of HEAD', async () => {
    initializeGitRepo()
    git(['switch', '-c', 'foreign'])
    writeFileSync(join(repoRoot, 'foreign.txt'), 'foreign\n')
    git(['add', 'foreign.txt'])
    git(['commit', '-m', 'foreign'])
    const foreignSha = git(['rev-parse', 'HEAD'])
    git(['switch', 'main'])
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'foreign merged fix', body: '', labels: ['loop:in-progress'],
    })
    await fakeForge.commentIssue(
      issueNumber,
      `MERGED: remote-task\nMerged as ${foreignSha} into run branch feature/other-run. This issue closes on promotion.`,
    )

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
  })

  it('does not exempt a merge marker with no parseable SHA', async () => {
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'unverifiable merged fix', body: '', labels: ['loop:in-progress'],
    })
    await fakeForge.commentIssue(issueNumber, 'MERGED: remote-task\nMerged by another checkout.')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
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
  it('reports only execution counters when scans are not running', async () => {
    const loop = makeLoop({ scanEnabled: false, maxScanCycles: 6 })

    expect(await loop.poll()).toBe('continue')
    expect(logText()).toMatch(/^Status Running=\d+  Queue=\d+$/m)
  })

  it('reports only scan counters while scans run', async () => {
    const loop = makeLoop({ scanEnabled: false })
    writeRawStatus('20260809_000000_001_scan', 'running', process.pid)

    expect(await loop.poll()).toBe('continue')
    expect(logged).toContain('Status Scan=1')
  })

  it('reports both phase groups when scans and tasks run together', async () => {
    const loop = makeLoop({ scanEnabled: false })
    writeRawStatus('20260809_000000_001_scan', 'running', process.pid)
    writeRawStatus('20260809_000001_002_auto-fix', 'running', process.pid)

    expect(await loop.poll()).toBe('continue')
    expect(logged).toContain('Status Scan=1  Running=1  Queue=0')
  })

  it('announces a failure once, records it for the cycle, and stops on a burst', async () => {
    const loop = makeLoop({ autoMerge: false, scanEnabled: false, maxBurstFailures: 3 })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '4\n')
    for (const taskId of ['f1', 'f2', 'f3']) {
      writeRawStatus(taskId, 'running', null)
    }

    expect(await loop.poll()).toBe('continue')
    for (const taskId of ['f1', 'f2', 'f3']) {
      expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`)
      expect(logText()).toContain(`Failed ${taskId.padEnd(12)}log ${taskId}.log`)
    }
    const failedRecord = readFileSync(join(paths.queueDir, 'failed-4'), 'utf8')
    expect(failedRecord.trim().split('\n')).toHaveLength(3)
    expect(logText()).toContain('ERROR 3 tasks failed in one poll; stopping for environment repair')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)

    // The next poll consumes the stop and exits; the failures are not announced again.
    logged = []
    expect(await loop.poll()).toBe('stopped')
    expect(logText()).not.toContain('Failed f1')
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
    expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`)
    expect(logged).toContain('CYCLE_COMPLETE: 1/3')
    expect(logged.indexOf(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.log`)}`))
      .toBeLessThan(logged.indexOf('CYCLE_COMPLETE: 1/3'))
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

  it('releases a claimed issue immediately when task startup fails', async () => {
    initializeGitRepo()
    const description = '[BUG] recover a claimed task after startup fails'
    const attemptedTaskIds: string[] = []
    let attempt = 0
    const runner: Runner = {
      start: async (options) => {
        attemptedTaskIds.push(options.specFile.replace(/^.*[\\/]/, '').replace(/\.md$/, ''))
        if (attempt++ === 0) throw new Error('runner spawn failed')
        return process.pid
      },
    }
    const loop = makeLoop(
      { issueQueueEnabled: true, scanEnabled: false, maxParallel: 1 },
      stubProject,
      undefined,
      () => new Date(2026, 7, 8, 12, 0, 0),
      runner,
    )
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'startup recovery',
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    const firstTaskId = attemptedTaskIds[0]!
    const released = await fakeForge.getIssue(issueNumber)
    expect(released.labels).toContain(LABEL_READY)
    expect(released.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(released.assignees).toEqual([])
    expect(logged).toContain('Released 001_auto    startup failed')
    expect(existsSync(join(paths.tasksDir, `${firstTaskId}.md`))).toBe(false)
    expect(existsSync(statusFile(paths, firstTaskId))).toBe(false)
    expect(existsSync(worktreeDir(paths, firstTaskId))).toBe(false)
    expect(existingTaskIdForDesc(paths, 'auto', description)).toBeUndefined()

    expect(await loop.poll()).toBe('continue')

    expect(attemptedTaskIds).toHaveLength(2)
    expect(attemptedTaskIds[1]).not.toBe(firstTaskId)
    const reclaimed = await fakeForge.getIssue(issueNumber)
    expect(reclaimed.labels).toContain(LABEL_IN_PROGRESS)
    expect(reclaimed.labels).not.toContain(LABEL_READY)
    expect(reclaimed.assignees).toEqual(['worker-a'])
  })
})

describe('completion marker output', () => {
  it('emits LOOP_DONE verbatim before the formatted completion row', async () => {
    initializeGitRepo()
    const remote = join(repoRoot, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true })
    git(['remote', 'add', 'origin', remote])
    git(['push', '-u', 'origin', 'main'])
    const loop = makeLoop()

    await loop.postLoopPr()

    expect(logged).toContain(
      'LOOP_DONE: https://example.test/pull/1 — The body still reflects history and must be rewritten as a final summary.',
    )
    expect(logged).toContain('Completed Loop        PR #1')
    expect(logged.indexOf('LOOP_DONE: https://example.test/pull/1 — The body still reflects history and must be rewritten as a final summary.'))
      .toBeLessThan(logged.indexOf('Completed Loop        PR #1'))
  })
})

describe('completed task merge recovery', () => {
  it('retries a failed automerge on the next poll and lets the cycle gate proceed', async () => {
    const taskId = '20260810_040800_064_auto-retry-merge'
    initializeGitRepo()
    makeCompletedTask(taskId)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    let mergeChecks = 0
    const transientProject: ProjectAdapter = {
      ...stubProject,
      mergeChecks: () => ++mergeChecks === 1
        ? [{ label: 'Transient outage', cwd: '', command: 'node -e "process.exit(1)"' }]
        : [],
    }
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: true,
      reviewEnabled: true,
      autoReview: false,
      autoPr: false,
      taskGate: 'full',
    }, transientProject)
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'pending fix', body: '', labels: ['loop:in-progress'],
    })
    recordIssueForTask(paths, taskId, issueNumber)

    expect(await loop.poll()).toBe('continue')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(logged).toContain('Waiting remote  issues #1')

    expect(await loop.poll()).toBe('continue')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(logged.filter((line) => line.startsWith('Merging 064_auto'))).toHaveLength(2)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
  })

  it('merges when a claim finds its existing local task completed but unmerged', async () => {
    const taskId = '20260810_040800_064_auto-claimed-again'
    const description = '[BUG] retry the completed local task'
    initializeGitRepo()
    makeCompletedTask(taskId, false)
    recordTaskIdForDesc(paths, 'auto', description, taskId)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    await fakeForge.createIssue({
      title: 'retry completed work',
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const listOpenIssues = fakeForge.listOpenIssues.bind(fakeForge)
    let exposedCompletion = false
    fakeForge.listOpenIssues = async (label) => {
      if (label === LABEL_READY && !exposedCompletion) {
        exposedCompletion = true
        writeRawStatus(taskId, 'completed')
      }
      return listOpenIssues(label)
    }

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(runnerStarts).toHaveLength(0)
    expect(logged).toContain('Claimed 064_auto    #1')
    expect(logged).toContain('Merging 064_auto')
    expect(logged.some((line) => line.startsWith('Merged 064_auto'))).toBe(true)
    expect(logged.indexOf('Claimed 064_auto    #1'))
      .toBeLessThan(logged.indexOf('Merging 064_auto'))
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
    expect(logText()).toContain('ERROR 3 consecutive merge failures; stopping the loop')
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
    expect(logged).toContain('Started Suite  cycle 1')
  })

  it('stops before running suite steps when the Docker probe fails', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuiteDockerProbe: { command: 'exit 1', timeoutMs: 1_000 },
      cycleSuite: () => [{
        label: 'Docker suite', cwd: '', command: 'touch suite-ran', needsDocker: true,
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(1)).toBe(false)

    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(false)
    expect(existsSync(stopFile())).toBe(true)
    expect(logText()).toContain(
      'ERROR Docker is not running; the cycle suite needs it (start Docker Desktop and restart the loop)',
    )
  })

  it('probes once and runs Docker-dependent suite steps when the probe passes', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuiteDockerProbe: { command: 'echo probe >> docker-probes', timeoutMs: 1_000 },
      cycleSuite: () => [
        { label: 'First Docker suite', cwd: '', command: 'touch suite-ran', needsDocker: true },
        { label: 'Second Docker suite', cwd: '', command: 'touch suite-ran-again', needsDocker: true },
      ],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(1)).toBe(true)

    expect(existsSync(join(repoRoot, 'suite-ran'))).toBe(true)
    expect(existsSync(join(repoRoot, 'suite-ran-again'))).toBe(true)
    expect(readFileSync(join(repoRoot, 'docker-probes'), 'utf8').trim()).toBe('probe')
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
    expect(logText()).toContain('ERROR cycle suite failed')
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
    expect(logText()).toContain('ERROR cycle suite tool missing')
    expect(existsSync(stopFile())).toBe(true)
  })

  it('attributes a Docker failure after a passing probe to the environment', () => {
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuiteDockerProbe: { command: 'true', timeoutMs: 1_000 },
      cycleSuite: () => [{
        label: 'Docker suite', cwd: '', needsDocker: true,
        command: 'echo "Could not find a valid Docker environment"; exit 1',
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(5)).toBe(false)

    expect(logText()).toContain('ERROR Docker is not running; the cycle suite needs it')
    expect(logText()).not.toContain('ERROR cycle suite failed')
    expect(existsSync(stopFile())).toBe(true)
  })

  it('classifies only the current run when a reused log contains an earlier tool failure', () => {
    const suiteLog = join(paths.logsDir, 'cycle-suite-6.log')
    writeFileSync(suiteLog, 'vitest is not recognized as an internal or external command\n')
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Failing test', cwd: '', command: 'echo "Tests run: 4, Failures: 1"; exit 1',
      }],
    }
    const loop = makeLoop({ taskGate: 'light' }, suiteProject)

    expect(loop.runCycleSuite(6)).toBe(false)

    expect(logText()).toContain('ERROR cycle suite failed')
    expect(logText()).not.toContain('tool missing')
    expect(readFileSync(suiteLog, 'utf8')).toContain('Tests run: 4, Failures: 1')
    expect(readFileSync(suiteLog, 'utf8')).not.toContain('vitest is not recognized')
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
    expect(logText()).toContain('WARN growth depth limit 1 ignored findings from deep-parent')
  })

  it('re-admits a review finding whose indexed task failed or already merged', async () => {
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

    // Once the fix landed, a later review saw the post-fix tree and must create new work.
    writeRawStatus(taskId, 'merged')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    logged = []
    writeFinal('20250101_000000_022_review-c1', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_022_review-c1', 0)
    const freshTaskId = readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8').trim().split(':')[0]
    expect(freshTaskId).not.toBe(taskId)
    expect(readdirSync(paths.tasksDir)).toHaveLength(2)
    expect(logText()).not.toContain('Duplicate finding')
  })
})
