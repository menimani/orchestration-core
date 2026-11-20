import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import { pitfallsFileForDesc } from '../src/gates.ts'
import { shortTaskId } from '../src/ids.ts'
import { cleanupTask } from '../src/cleanup.ts'
import { runCleanupCommand } from '../src/cleanupCommand.ts'
import { buildIssueBody, LABEL_FINDING, LABEL_READY } from '../src/issueQueue.ts'
import type { Loop } from '../src/loop.ts'
import {
  branchName, statusFile, worktreeDir,
} from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import { enqueueTask, specFile } from '../src/tasks.ts'
import {
  backlogEntries, fakeForge, git, initializeGitRepo, initializeGitRepoWithRemote, logText,
  logged, makeCompletedTask, makeForge, makeLoop, makeRunner, paths, registerLoopHooks,
  repoRoot, runnerStarts, setLogged, stubProject, useFakeRepository, writeFinal, writeRawStatus,
} from './loopHarness.ts'

const cleanupFailure = vi.hoisted(() => ({ taskId: undefined as string | undefined }))

// Cleanup runs unchanged unless a test names a task whose cleanup must fail once.
vi.mock('../src/cleanup.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cleanup.ts')>()
  return {
    ...actual,
    cleanupTask: (...args: Parameters<typeof actual.cleanupTask>) => {
      if (args[1] === cleanupFailure.taskId) {
        cleanupFailure.taskId = undefined
        throw new Error('worktree is locked')
      }
      actual.cleanupTask(...args)
    },
  }
})

const mergedStatusFailure = vi.hoisted(() => ({
  taskId: undefined as string | undefined,
  onWrite: undefined as (() => void) | undefined,
}))

// Recording a merge runs unchanged unless a test names a task whose process must die
// right after the merged status reaches disk.
vi.mock('../src/status.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/status.ts')>()
  return {
    ...actual,
    writeMergedStatus: async (...args: Parameters<typeof actual.writeMergedStatus>) => {
      if (args[1] !== mergedStatusFailure.taskId) return actual.writeMergedStatus(...args)
      mergedStatusFailure.taskId = undefined
      mergedStatusFailure.onWrite?.()
      await actual.writeMergedStatus(...args)
      throw new Error('process stopped after recording the merge')
    },
  }
})

registerLoopHooks()

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
    expect(lines[lines.length - 1]).toBe('20250101_000000_003_scan\tempty')
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

  it('folds only a complete set of successful scan yields', () => {
    const loop = makeLoop({ maxEmptyScans: 2 })
    const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')

    writeFileSync(join(paths.queueDir, 'scan-expected-3'), '2\n')
    writeFileSync(join(paths.queueDir, 'scan-yield-3'), 'found\nempty\n')
    writeFileSync(emptyScanFile, '1\n')
    loop.foldScanYields(3)
    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('0')
    expect(existsSync(join(paths.queueDir, 'scan-yield-3'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'scan-expected-3'))).toBe(false)

    writeFileSync(join(paths.queueDir, 'scan-expected-4'), '2\n')
    writeFileSync(join(paths.queueDir, 'scan-yield-4'), 'empty\n')
    writeFileSync(emptyScanFile, '1\n')
    loop.foldScanYields(4)
    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('1')
    expect(existsSync(join(paths.queueDir, 'scan-yield-4'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'scan-expected-4'))).toBe(true)

    writeFileSync(join(paths.queueDir, 'scan-yield-4'), 'empty\nempty\n')
    loop.foldScanYields(4)
    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('2')

    loop.foldScanYields(5)
    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('2')
  })

  it('deduplicates a scan yield recorded again after a crash before its scanned marker', () => {
    const loop = makeLoop({ maxEmptyScans: 2 })
    const taskId = '20250101_000000_006_scan'
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '3\n')
    writeFileSync(join(paths.queueDir, 'scan-expected-3'), '1\n')
    writeFileSync(join(paths.queueDir, 'empty-scan-count.txt'), '0\n')
    writeFinal(taskId, '')

    loop.recordScanYield(taskId)
    loop.recordScanYield(taskId)
    loop.foldScanYields(3)

    expect(readFileSync(join(paths.queueDir, 'empty-scan-count.txt'), 'utf8')).toBe('1\n')
    expect(existsSync(join(paths.queueDir, 'scan-yield-3'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'scan-expected-3'))).toBe(false)
  })

  it('closes a cycle whose only scans failed without counting it as empty', () => {
    const loop = makeLoop({ maxScanCycles: 6, maxEmptyScans: 2 })
    const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')
    writeFileSync(join(paths.queueDir, 'scan-expected-3'), '1\n')
    writeFileSync(join(paths.queueDir, 'failed-3'), '20250101_000000_007_scan\n')
    writeFileSync(emptyScanFile, '1\n')

    expect(loop.cycleIsFinal(3)).toBe(false)
    loop.foldScanYields(3)

    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('1')
    expect(existsSync(join(paths.queueDir, 'scan-expected-3'))).toBe(false)
  })

  it('leaves the empty counter alone when a failed scan joins empty yields', () => {
    const loop = makeLoop({ maxScanCycles: 6, maxEmptyScans: 2 })
    const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')
    writeFileSync(join(paths.queueDir, 'scan-expected-4'), '2\n')
    writeFileSync(join(paths.queueDir, 'scan-yield-4'), '20250101_000000_008_scan\tempty\n')
    writeFileSync(join(paths.queueDir, 'failed-4'), '20250101_000000_009_scan\n')
    writeFileSync(emptyScanFile, '1\n')

    expect(loop.cycleIsFinal(4)).toBe(false)
    loop.foldScanYields(4)

    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('1')
    expect(existsSync(join(paths.queueDir, 'scan-yield-4'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'scan-expected-4'))).toBe(false)
  })

  it('resets the empty counter when a cycle both found and lost a scan', () => {
    const loop = makeLoop({ maxEmptyScans: 2 })
    const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')
    writeFileSync(join(paths.queueDir, 'scan-expected-5'), '2\n')
    writeFileSync(join(paths.queueDir, 'scan-yield-5'), '20250101_000000_010_scan\tfound\n')
    writeFileSync(join(paths.queueDir, 'failed-5'), '20250101_000000_011_scan\n')
    writeFileSync(emptyScanFile, '1\n')

    loop.foldScanYields(5)

    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('0')
  })

  it('ignores a failed task that is not a scan', () => {
    const loop = makeLoop({ maxEmptyScans: 2 })
    const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')
    writeFileSync(join(paths.queueDir, 'scan-expected-6'), '2\n')
    writeFileSync(join(paths.queueDir, 'scan-yield-6'), '20250101_000000_012_scan\tempty\n')
    writeFileSync(join(paths.queueDir, 'failed-6'), '20250101_000000_013_auto-a-finding\n')
    writeFileSync(emptyScanFile, '1\n')

    loop.foldScanYields(6)

    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('1')
    expect(existsSync(join(paths.queueDir, 'scan-expected-6'))).toBe(true)
  })

  it('closes a cycle whose unfinished scan the operator cleaned up', async () => {
    const loop = makeLoop({ maxEmptyScans: 2 })
    const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')
    const cleanedScan = '20250101_000000_014_scan'
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '7\n')
    writeFileSync(join(paths.queueDir, 'scan-expected-7'), '2\n')
    writeFileSync(join(paths.queueDir, 'scan-yield-7'), '20250101_000000_015_scan\tempty\n')
    writeFileSync(emptyScanFile, '1\n')
    writeRawStatus(cleanedScan, 'running')

    await expect(runCleanupCommand(paths, [cleanedScan], {
      issueQueueEnabled: () => false,
      loadForge: async () => makeForge(),
      cleanup: (cleanupPaths, taskId) => rmSync(statusFile(cleanupPaths, taskId)),
      error: () => {},
    })).resolves.toBe(0)

    expect(existsSync(statusFile(paths, cleanedScan))).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'failed-7'), 'utf8')).toBe(`${cleanedScan}\n`)
    loop.foldScanYields(7)
    expect(existsSync(join(paths.queueDir, 'scan-expected-7'))).toBe(false)
    expect(readFileSync(emptyScanFile, 'utf8').trim()).toBe('1')
  })

  it('does not count a cleaned-up scan as failed once its yield was recorded', async () => {
    const yieldedScan = '20250101_000000_016_scan'
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '8\n')
    writeFileSync(join(paths.queueDir, 'scan-expected-8'), '2\n')
    writeFileSync(join(paths.queueDir, 'scan-yield-8'), `${yieldedScan}\tfound\n`)
    writeRawStatus(yieldedScan, 'completed')

    await expect(runCleanupCommand(paths, [yieldedScan], {
      issueQueueEnabled: () => false,
      loadForge: async () => makeForge(),
      cleanup: (cleanupPaths, taskId) => rmSync(statusFile(cleanupPaths, taskId)),
      error: () => {},
    })).resolves.toBe(0)

    expect(existsSync(join(paths.queueDir, 'failed-8'))).toBe(false)
  })
})

describe('runAutoReview', () => {
  beforeEach(() => {
    initializeGitRepoWithRemote()
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'review-template.md'),
      '# {{REVIEW_ID}} review of cycle {{CYCLE}} against {{BASE_BRANCH}} for {{PR_URL}}\n')
  })

  function lastReviewId(cycle: number): string {
    return readFileSync(join(paths.queueDir, `review-id-${cycle}`), 'utf8').trim()
  }

  it('refreshes an intact remote default branch before generating the review', () => {
    const staleBase = git(['rev-parse', 'refs/remotes/origin/main'])
    writeFileSync(join(repoRoot, 'tracked.txt'), 'advanced\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'advance default branch'])
    const advancedBase = git(['rev-parse', 'HEAD'])
    git(['push', 'origin', 'main'])
    git(['update-ref', 'refs/remotes/origin/main', staleBase])

    expect(makeLoop().runAutoReview(7, false)).toBe(false)

    expect(git(['rev-parse', 'refs/remotes/origin/main'])).toBe(advancedBase)
    const spec = readFileSync(join(paths.tasksDir, `${lastReviewId(7)}.md`), 'utf8')
    expect(spec).toContain('against origin/main')
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

describe('scanForNextTasks', () => {
  beforeEach(() => {
    mkdirSync(join(paths.root, 'templates', 'pitfalls'), { recursive: true })
    const pitfalls = {
      'code.md': 'Stale async responses.\n',
      'docs.md': 'Project documentation pitfalls.\n',
      'tests.md': 'clearAllMocks keeps implementations.\n',
    }
    for (const [name, content] of Object.entries(pitfalls)) {
      writeFileSync(join(paths.root, 'templates', 'pitfalls', name), content)
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
    expect(fixId).toContain('_fix-')
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
    expect(fixId).toContain('_fix-')
    expect(descIndexes.every((name) => name.startsWith('fix-'))).toBe(true)
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

    const taskIds = readdirSync(paths.tasksDir).map((name) => name.replace(/\.md$/, ''))
    expect(taskIds).toHaveLength(3)
    expect(taskIds.every((taskId) => taskId.includes('_auto-'))).toBe(true)
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

  it('retries incomplete finding publication before marking a scan processed', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoMerge: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const taskId = '20250101_000000_017_scan'
    writeFinal(taskId, [
      'NEXT_TASK: [BUG] first retryable finding',
      'NEXT_TASK: [BUG] second retryable finding',
      'TASK_COMPLETE',
    ].join('\n'))
    writeRawStatus(taskId, 'completed')

    const createIssue = fakeForge.createIssue.bind(fakeForge)
    let attempts = 0
    fakeForge.createIssue = async (options) => {
      attempts += 1
      if (attempts === 2) throw new Error('temporary publication failure')
      return createIssue(options)
    }

    await loop.poll()

    const scannedFlag = join(paths.queueDir, 'scanned', taskId)
    expect(existsSync(scannedFlag)).toBe(false)
    expect(fakeForge.issues.size).toBe(1)
    expect(logText()).toContain(
      'WARN could not file finding from 017_scan: temporary publication failure',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logged.some((line) => line.startsWith('Completed 017_scan'))).toBe(false)

    await loop.poll()

    expect(existsSync(scannedFlag)).toBe(true)
    expect(fakeForge.issues.size).toBe(2)
    expect([...fakeForge.issues.values()].map((issue) => issue.title)).toEqual([
      '[BUG] first retryable finding',
      '[BUG] second retryable finding',
    ])
    expect(logged.filter((line) => line.startsWith('Completed 017_scan'))).toHaveLength(1)
  })

  it('logs and stops after repeated finding publication failures', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoMerge: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const taskId = '20250101_000000_026_scan'
    writeFinal(taskId, [
      'NEXT_TASK: [BUG] first rejected finding',
      'NEXT_TASK: [BUG] second rejected finding',
      'TASK_COMPLETE',
    ].join('\n'))
    writeRawStatus(taskId, 'completed')
    fakeForge.createIssue = async () => {
      throw new Error('issue body is too long')
    }
    const scannedFlag = join(paths.queueDir, 'scanned', taskId)
    const stopFile = join(paths.queueDir, 'stop')

    await loop.poll()

    expect(existsSync(scannedFlag)).toBe(false)
    expect(logText()).toContain('WARN could not file finding from 026_scan: issue body is too long')
    expect(logText()).not.toContain('ERROR could not file finding')
    expect(existsSync(stopFile)).toBe(false)

    await loop.poll()

    expect(existsSync(scannedFlag)).toBe(false)
    expect(fakeForge.issues.size).toBe(0)
    expect(logText()).toContain(
      'ERROR could not file finding from 026_scan: issue body is too long (repeated 2 times)',
    )
    expect(existsSync(stopFile)).toBe(true)
  })

  it('does not count a rate-limited finding publication as a gate failure', async () => {
    const loop = makeLoop({ issueQueueEnabled: true })
    const taskId = '20250101_000000_027_scan'
    writeFinal(taskId, 'NEXT_TASK: [BUG] a finding filed during a rate limit\n')
    fakeForge.createIssue = async () => {
      throw new ForgeRateLimitError(new Date(Date.now() + 60_000))
    }

    expect((await loop.scanForNextTasks(taskId, 0)).reconciled).toBe(false)
    expect((await loop.scanForNextTasks(taskId, 0)).reconciled).toBe(false)

    expect(logText()).not.toContain('could not file finding')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('retries an unscanned review completion after a forge lookup outage and warns once', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoMerge: false,
      maxParallel: 0,
      maxConsecutiveMergeFailures: 10,
    })
    loop.initializeSessionStateForBranch()
    const taskId = '20250101_000000_019_review-c1'
    writeFinal(taskId, [
      'NEXT_TASK: [BUG] retain a review finding across a forge outage',
      'TASK_COMPLETE',
    ].join('\n'))
    writeRawStatus(taskId, 'completed')
    const scannedFlag = join(paths.queueDir, 'scanned', taskId)
    const listOpenIssues = fakeForge.listOpenIssues.bind(fakeForge)
    fakeForge.listOpenIssues = async () => {
      throw new Error('temporary review lookup failure')
    }

    await expect(loop.poll()).resolves.toBe('continue')
    await expect(loop.poll()).resolves.toBe('continue')

    expect(existsSync(scannedFlag)).toBe(false)
    expect(fakeForge.issues.size).toBe(0)
    expect(logged.filter((line) =>
      line.includes('WARN could not check review findings from 019_review')))
      .toHaveLength(1)

    fakeForge.listOpenIssues = listOpenIssues
    await loop.poll()

    expect(existsSync(scannedFlag)).toBe(true)
    expect(fakeForge.issues.size).toBe(1)
    expect(logText()).toContain(
      'Recovered checking review findings from 019_review after 0 minutes',
    )
  })

  it('stops when a review or documentation completion cannot check its findings twice', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoMerge: false,
      maxParallel: 0,
      maxConsecutiveMergeFailures: 10,
    })
    loop.initializeSessionStateForBranch()
    const reviewId = '20250101_000000_028_review-c1'
    const docsId = '20250101_000000_029_scan'
    writeFinal(reviewId, [
      'NEXT_TASK: [BUG] a review finding behind a malformed ledger',
      'TASK_COMPLETE',
    ].join('\n'))
    writeFinal(docsId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'TASK_COMPLETE',
    ].join('\n'))
    writeRawStatus(reviewId, 'completed')
    writeRawStatus(docsId, 'completed')
    const ledgerFile = join(paths.queueDir, 'issue-fingerprints')
    writeFileSync(ledgerFile, 'malformed line here\n')
    const stopFile = join(paths.queueDir, 'stop')

    await loop.poll()

    expect(logText()).toContain('WARN could not check review findings from 028_review')
    expect(logText()).toContain('WARN could not check documentation findings from 029_scan')
    expect(logText()).not.toContain('ERROR could not check')
    expect(existsSync(stopFile)).toBe(false)

    await loop.poll()

    for (const taskId of [reviewId, docsId]) {
      expect(existsSync(join(paths.queueDir, 'scanned', taskId))).toBe(false)
      expect(readStatus(paths, taskId)?.status).toBe('completed')
    }
    expect(fakeForge.issues.size).toBe(0)
    expect(logText()).toMatch(
      /ERROR could not check review findings from 028_review: Malformed fingerprint ledger .* \(repeated 2 times\)/,
    )
    expect(logText()).toMatch(
      /ERROR could not check documentation findings from 029_scan: Malformed fingerprint ledger .* \(repeated 2 times\)/,
    )
    expect(existsSync(stopFile)).toBe(true)
    expect(readFileSync(ledgerFile, 'utf8')).toBe('malformed line here\n')
  })

  it('stops when the issue-queue sync meets a malformed ledger twice', async () => {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const description = '[BUG] `src/shared.ts` finding behind a malformed ledger'
    const issueNumber = await fakeForge.createIssue({
      title: description,
      body: buildIssueBody(description, 'scan-1'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const ledgerFile = join(paths.queueDir, 'issue-fingerprints')
    writeFileSync(ledgerFile, 'malformed line here\n')
    const stopFile = join(paths.queueDir, 'stop')

    await loop.poll()

    expect(logText()).toMatch(/WARN could not sync the issue queue: Malformed fingerprint ledger/)
    expect(logText()).not.toContain('issue queue unreachable')
    expect(existsSync(stopFile)).toBe(false)

    await loop.poll()

    expect(logText()).toMatch(
      /ERROR could not sync the issue queue: Malformed fingerprint ledger .* \(repeated 2 times\)/,
    )
    expect(existsSync(stopFile)).toBe(true)
    expect(runnerStarts).toEqual([])
    expect(fakeForge.issues.get(issueNumber)?.labels).toContain(LABEL_READY)
    expect(readFileSync(ledgerFile, 'utf8')).toBe('malformed line here\n')
  })

  const findingCheckKinds = [
    ['review', '20250101_000000_030_review-c1', 'NEXT_TASK: [BUG] a review finding behind a forge outage'],
    ['documentation', '20250101_000000_031_scan', 'NEXT_TASK: [DOCS] `README.md` names a flag the outage hid'],
  ] as const

  function prepareFailingFindingCheck(taskId: string, finding: string): {
    loop: Loop
    scannedFlag: string
    stopFile: string
    restore: () => void
  } {
    useFakeRepository()
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoMerge: false,
      maxParallel: 0,
      maxConsecutiveMergeFailures: 10,
    })
    loop.initializeSessionStateForBranch()
    writeFinal(taskId, [finding, 'TASK_COMPLETE'].join('\n'))
    writeRawStatus(taskId, 'completed')
    const listOpenIssues = fakeForge.listOpenIssues.bind(fakeForge)
    fakeForge.listOpenIssues = async () => {
      throw new Error('forge lookup unavailable')
    }
    return {
      loop,
      scannedFlag: join(paths.queueDir, 'scanned', taskId),
      stopFile: join(paths.queueDir, 'stop'),
      restore: () => {
        fakeForge.listOpenIssues = listOpenIssues
      },
    }
  }

  it.each(findingCheckKinds)(
    'keeps polling through twenty failed %s finding checks and stops on the twenty-first',
    async (kind, taskId, finding) => {
      const { loop, scannedFlag, stopFile } = prepareFailingFindingCheck(taskId, finding)
      const subject = `could not check ${kind} findings from ${shortTaskId(taskId)}`
      const warnings = (): string[] => logged.filter((line) => line.includes(`WARN ${subject}: `))

      for (let poll = 1; poll <= 20; poll++) {
        await expect(loop.poll()).resolves.toBe('continue')
        expect(existsSync(stopFile)).toBe(false)
        if (poll === 2 || poll === 3 || poll === 20) {
          expect(warnings()).toEqual([expect.stringContaining(`${subject}: forge lookup unavailable`)])
          expect(logText()).not.toContain('ERROR could not check')
        }
        if (poll < 20) expect(logText()).not.toContain('consecutive polls')
      }
      expect(logged.filter((line) => line.includes(
        `WARN ${subject} on 20 consecutive polls: forge lookup unavailable`,
      ))).toHaveLength(1)

      await loop.poll()

      expect(existsSync(stopFile)).toBe(true)
      expect(logText()).toContain(
        `ERROR ${subject} on 21 consecutive polls: forge lookup unavailable (repeated 2 times)`,
      )
      expect(existsSync(scannedFlag)).toBe(false)
      expect(readStatus(paths, taskId)?.status).toBe('completed')
    },
  )

  it.each(findingCheckKinds)(
    'logs the recovery when a %s finding check succeeds after failed polls',
    async (kind, taskId, finding) => {
      const { loop, scannedFlag, stopFile, restore } = prepareFailingFindingCheck(taskId, finding)

      for (let poll = 1; poll <= 19; poll++) await loop.poll()
      restore()
      await loop.poll()

      expect(existsSync(scannedFlag)).toBe(true)
      expect(logText()).toMatch(new RegExp(
        `Recovered checking ${kind} findings from ${shortTaskId(taskId)} after [0-9]+ minutes`,
      ))
      expect(logText()).not.toContain('consecutive polls')
      expect(logText()).not.toContain('ERROR could not check')
      expect(existsSync(stopFile)).toBe(false)
    },
  )

  it('starts the count of failed review finding checks again after a successful check', async () => {
    const [, taskId, finding] = findingCheckKinds[0]
    const { loop, scannedFlag, stopFile, restore } = prepareFailingFindingCheck(taskId, finding)
    const failingLookup = fakeForge.listOpenIssues
    const createIssue = fakeForge.createIssue.bind(fakeForge)

    for (let poll = 1; poll <= 19; poll++) await loop.poll()
    // The check succeeds, but the rate-limited filing leaves the completion for a later poll.
    restore()
    fakeForge.createIssue = async () => {
      throw new ForgeRateLimitError(new Date(0))
    }
    await loop.poll()

    expect(existsSync(scannedFlag)).toBe(false)
    expect(logText()).toContain('Recovered checking review findings from 030_review')

    fakeForge.listOpenIssues = failingLookup
    fakeForge.createIssue = createIssue
    for (let poll = 1; poll <= 19; poll++) {
      await expect(loop.poll()).resolves.toBe('continue')
    }

    expect(logText()).not.toContain('consecutive polls')
    expect(logText()).not.toContain('ERROR could not check')
    expect(existsSync(stopFile)).toBe(false)
  })

  it.each(findingCheckKinds)(
    'neither counts nor clears failed %s finding checks on a rate-limited poll',
    async (kind, taskId, finding) => {
      const { loop, stopFile } = prepareFailingFindingCheck(taskId, finding)
      const failingLookup = fakeForge.listOpenIssues
      const subject = `could not check ${kind} findings from ${shortTaskId(taskId)}`

      for (let poll = 1; poll <= 10; poll++) await loop.poll()
      fakeForge.listOpenIssues = async () => {
        throw new ForgeRateLimitError(new Date(0))
      }
      await loop.poll()
      fakeForge.listOpenIssues = failingLookup
      for (let poll = 1; poll <= 9; poll++) await loop.poll()

      expect(logText()).not.toContain('consecutive polls')

      await loop.poll()

      expect(logText()).toContain(`WARN ${subject} on 20 consecutive polls: forge lookup unavailable`)
      expect(existsSync(stopFile)).toBe(false)

      await loop.poll()

      expect(logText()).toContain(
        `ERROR ${subject} on 21 consecutive polls: forge lookup unavailable (repeated 2 times)`,
      )
      expect(existsSync(stopFile)).toBe(true)
    },
  )

  it('leaves a local finding unreconciled when enqueue fails so a later scan retries it', async () => {
    initializeGitRepo()
    const initialHead = git(['rev-parse', 'HEAD'])
    let attempts = 0
    const loop = makeLoop(
      {
        scanEnabled: false,
        autoMerge: true,
        maxParallel: 0,
        reviewEnabled: true,
        autoReview: false,
      },
      stubProject, undefined, () => new Date(2026, 7, 8, 12, 0, 0), makeRunner(),
      (...args) => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary local queue failure')
        return enqueueTask(...args)
      },
    )
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const taskId = '20250101_000000_018_auto-parent'
    makeCompletedTask(taskId)
    writeFinal(taskId, [
      'NEXT_TASK: [BUG] retry a finding after a local queue failure',
      'TASK_COMPLETE',
    ].join('\n'))
    const backlog = join(paths.queueDir, 'backlog.txt')
    const scannedFlag = join(paths.queueDir, 'scanned', taskId)

    await loop.poll()

    expect(existsSync(scannedFlag)).toBe(false)
    expect(readdirSync(paths.tasksDir)).toHaveLength(2)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)

    await loop.poll()

    expect(existsSync(scannedFlag)).toBe(true)
    expect(attempts).toBe(2)
    expect(readFileSync(backlog, 'utf8').trim()).toMatch(/:1$/)
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(git(['rev-parse', 'HEAD'])).not.toBe(initialHead)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
  })

  it('logs and stops after repeated local finding enqueue failures', async () => {
    const loop = makeLoop(
      {}, stubProject, undefined, () => new Date(2026, 7, 8, 12, 0, 0), makeRunner(),
      () => { throw new Error('persistent local queue failure') },
    )
    const taskId = '20250101_000000_025_scan'
    writeFinal(taskId, 'NEXT_TASK: [BUG] preserve a failed completion scan\n')

    expect((await loop.scanForNextTasks(taskId, 0)).reconciled).toBe(false)
    expect(logText()).toContain(
      'WARN could not enqueue finding from 025_scan: persistent local queue failure',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    expect((await loop.scanForNextTasks(taskId, 0)).reconciled).toBe(false)
    expect(logText()).toContain(
      'ERROR could not enqueue finding from 025_scan: persistent local queue failure (repeated 2 times)',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
  })

  it('counts one gate failure when several local findings fail to enqueue in one attempt', async () => {
    const loop = makeLoop(
      {}, stubProject, undefined, () => new Date(2026, 7, 8, 12, 0, 0), makeRunner(),
      () => { throw new Error('persistent local queue failure') },
    )
    const taskId = '20250101_000000_026_scan'
    writeFinal(
      taskId,
      'NEXT_TASK: [BUG] the first finding a broken queue rejects\n'
        + 'NEXT_TASK: [BUG] the second finding a broken queue rejects\n',
    )

    expect((await loop.scanForNextTasks(taskId, 0)).reconciled).toBe(false)
    const warnings = logText().split('\n')
      .filter((line) => line.includes('WARN could not enqueue finding from 026_scan'))
    expect(warnings).toHaveLength(1)
    expect(logText()).not.toContain('ERROR could not enqueue finding')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
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

  it('gives a scan-spawned docs task the docs pitfall list alone', async () => {
    const loop = makeLoop()
    writeFinal('20250101_000000_016_scan', 'NEXT_TASK: [DOCS] a stale README section a scan found\n')
    await loop.scanForNextTasks('20250101_000000_016_scan', 0)
    // A documentation finding waits for the cycle's other work, then is released alone.
    await loop.triggerScanIfIdle()

    const specs = readdirSync(paths.tasksDir)
    expect(specs).toHaveLength(1)
    const spec = readFileSync(join(paths.tasksDir, specs[0] as string), 'utf8')
    expect(spec).toContain('Shared requirements.\n\nProject documentation pitfalls.\n')
    expect(spec).not.toContain('Stale async responses')
    expect(spec).not.toContain('clearAllMocks keeps implementations')
  })

  it('selects the pitfall list from the tag of an imported requirement', () => {
    const imported = (title: string): string => [
      `> ${title}`,
      'Imported from issue 9 of acme/widget, opened by octo.',
      '> The body.',
    ].join('\n\n')
    const pitfallsDir = join(paths.projectRoot, 'templates', 'pitfalls')

    expect(pitfallsFileForDesc(paths, imported('[TEST] cover the retry path')))
      .toBe(join(pitfallsDir, 'tests.md'))
    expect(pitfallsFileForDesc(paths, imported('[DOCS] a stale README section')))
      .toBe(join(pitfallsDir, 'docs.md'))
    expect(pitfallsFileForDesc(paths, imported('[BUG] a defect')))
      .toBe(join(pitfallsDir, 'code.md'))
  })

  it('adds no pitfall list when the selected file is missing', async () => {
    rmSync(join(paths.root, 'templates', 'pitfalls', 'docs.md'))
    const loop = makeLoop()
    writeFinal('20250101_000000_017_scan', 'NEXT_TASK: [DOCS] a stale README section a scan found\n')
    await loop.scanForNextTasks('20250101_000000_017_scan', 0)
    // A documentation finding waits for the cycle's other work, then is released alone.
    await loop.triggerScanIfIdle()

    const specs = readdirSync(paths.tasksDir)
    expect(specs).toHaveLength(1)
    const spec = readFileSync(join(paths.tasksDir, specs[0] as string), 'utf8')
    expect(spec.endsWith('\nShared requirements.\n')).toBe(true)
    expect(spec).not.toContain('Project documentation pitfalls')
    expect(spec).not.toContain('Stale async responses')
  })

  it('bounds growth by depth and by total task count', async () => {
    const loop = makeLoop({ maxGrowthDepth: 1 })
    writeFinal('deep-parent', 'NEXT_TASK: [BUG] too deep\n')
    await loop.scanForNextTasks('deep-parent', 1)
    expect(readdirSync(paths.tasksDir)).toHaveLength(0)
    expect(logText()).toContain('WARN growth depth limit 1 ignored findings from deep-parent')
  })

  it('checks the total-task bound before each local finding and keeps the count after completion', async () => {
    const loop = makeLoop({ maxTotalTasks: 2 })
    writeFinal('first-scan', [
      'NEXT_TASK: [BUG] first bounded finding',
      'NEXT_TASK: [BUG] second bounded finding',
      'NEXT_TASK: [BUG] third bounded finding',
    ].join('\n'))
    await loop.scanForNextTasks('first-scan', 0)

    const generated = readdirSync(paths.tasksDir)
    expect(generated).toHaveLength(2)
    writeRawStatus(generated[0]!.replace(/\.md$/, ''), 'merged')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')

    const restartedLoop = makeLoop({ maxTotalTasks: 2 })
    writeFinal('second-scan', 'NEXT_TASK: [BUG] terminal work must still consume the budget\n')
    await restartedLoop.scanForNextTasks('second-scan', 0)

    expect(readdirSync(paths.tasksDir)).toHaveLength(2)
    expect(readFileSync(join(paths.queueDir, 'total-task-count.txt'), 'utf8')).toBe('2\n')
    expect(logText()).toContain('WARN task limit 2 ignored findings from first-scan')
    expect(logText()).toContain('WARN task limit 2 ignored findings from second-scan')
  })

  it('checks the total-task bound before each remote finding and stores its depth', async () => {
    const loop = makeLoop({ issueQueueEnabled: true, maxTotalTasks: 1 })
    writeFinal('remote-scan', [
      'NEXT_TASK: [BUG] first remote bounded finding',
      'NEXT_TASK: [BUG] second remote bounded finding',
    ].join('\n'))
    await loop.scanForNextTasks('remote-scan', 1)

    expect(fakeForge.issues.size).toBe(1)
    const issue = [...fakeForge.issues.values()][0]!
    expect(issue.body).toContain('Depth: 2')
    expect(readFileSync(join(paths.queueDir, 'total-task-count.txt'), 'utf8')).toBe('1\n')
    expect(logText()).toContain('WARN task limit 1 ignored findings from remote-scan')
  })

  it('holds a review finding whose task failed until cleanup, and re-admits it after a merge', async () => {
    initializeGitRepo()
    const loop = makeLoop({ scanEnabled: false, maxParallel: 1 })
    const finding = '[BUG] a defect whose first fix crashed'

    writeFinal('20250101_000000_020_review-c1', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_020_review-c1', 0)
    const specs = readdirSync(paths.tasksDir)
    expect(specs).toHaveLength(1)
    const taskId = (specs[0] as string).replace(/\.md$/, '')

    // The first attempt failed and kept its worktree: re-queueing it would only be
    // refused at startup, so the finding waits for the operator's cleanup.
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeRawStatus(taskId, 'failed')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    setLogged([])
    writeFinal('20250101_000000_021_review-c1', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_021_review-c1', 0)
    expect(backlogEntries()).toEqual([])
    expect(readdirSync(paths.tasksDir)).toHaveLength(1)

    // After cleanup the same finding re-admits the task, and it actually starts.
    cleanupTask(paths, taskId, undefined, false, () => {})
    writeFinal('20250101_000000_022_review-c1', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_022_review-c1', 0)
    expect(backlogEntries()).toEqual([`${taskId}:1`])
    loop.initializeSessionStateForBranch()
    expect(await loop.poll()).toBe('continue')
    expect(runnerStarts).toEqual([specFile(paths, taskId)])
    expect(readStatus(paths, taskId)?.status).toBe('running')
    expect(logText()).not.toContain('startup failed')

    // Once the fix landed, a later review saw the post-fix tree and must create new work.
    writeRawStatus(taskId, 'merged')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    setLogged([])
    writeFinal('20250101_000000_023_review-c1', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_023_review-c1', 0)
    const freshTaskId = readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8').trim().split(':')[0]
    expect(freshTaskId).not.toBe(taskId)
    expect(readdirSync(paths.tasksDir)).toHaveLength(2)
    expect(logText()).not.toContain('Duplicate finding')
  })
})
