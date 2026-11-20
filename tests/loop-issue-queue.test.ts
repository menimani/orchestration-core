import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { LoopConfig } from '../src/config.ts'
import {
  buildIssueBody, recordIssuePromotions, recordIssuesForTask, LABEL_FINDING, LABEL_IN_PROGRESS,
  LABEL_MERGE_READY,
} from '../src/issueQueue.ts'
import type { Loop } from '../src/loop.ts'
import { enqueueTask, specFile } from '../src/tasks.ts'
import {
  backlogEntries, fakeForge, git, initializeGitRepo, initializeGitRepoWithRemote, logText,
  logged, makeLoop, makeRunner, paths, registerLoopHooks, repoRoot, stubProject,
  useFakeRepository, writeFinal, writeRawStatus,
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

describe('remote issue queue idle detection', () => {
  it('retries closed-issue lifecycle reconciliation during queue initialization', async () => {
    const loop = makeLoop({ issueQueueEnabled: true })
    let attempts = 0
    fakeForge.listClosedIssues = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('closed issue lookup failed')
      return []
    }

    expect(await loop.initializeIssueQueue()).toBe(false)
    expect(await loop.initializeIssueQueue()).toBe(true)

    expect(attempts).toBe(2)
    expect(logText()).toContain(
      'could not reconcile closed issue labels: closed issue lookup failed',
    )
  })

  it('reports recovery once queue label creation succeeds after a failure', async () => {
    const loop = makeLoop({ issueQueueEnabled: true })
    const listLabels = fakeForge.listLabels.bind(fakeForge)
    let attempts = 0
    fakeForge.listLabels = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('label listing failed')
      return listLabels()
    }

    expect(await loop.initializeIssueQueue()).toBe(false)
    expect(await loop.initializeIssueQueue()).toBe(true)

    expect(logText()).toContain(
      'WARN could not ensure issue queue labels: label listing failed',
    )
    expect(logText()).toContain('Recovered ensuring issue queue labels after 0 minutes')
  })

  beforeEach(() => {
    initializeGitRepoWithRemote()
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
      labels: [LABEL_FINDING, 'loop:ready', 'loop:in-progress'],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logged).toEqual(['Waiting remote      issues #1'])

    await loop.triggerScanIfIdle()
    expect(logged).toHaveLength(1)

    await fakeForge.createIssue({
      title: 'another pending fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    await loop.triggerScanIfIdle()
    expect(logged.at(-1)).toBe('Waiting remote      issues #1 #2')

    current = new Date(2026, 7, 8, 12, 9, 59)
    await loop.triggerScanIfIdle()
    expect(logged).toHaveLength(2)
    current = new Date(2026, 7, 8, 12, 10, 0)
    await loop.triggerScanIfIdle()
    expect(logged.at(-1)).toBe('Waiting remote      issues #1 #2')
    expect(logged).toHaveLength(3)
  })

  it('defers the cycle gate and review while an in-progress issue is open', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'claimed fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toBe('Waiting remote      issues #1')
  })

  it('stops with the repair when merge-failed issues are the only remaining work', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'adoption needs repair', body: '', labels: [LABEL_FINDING, 'loop:merge-failed'],
    })
    const reason = 'Issues #1 are labelled loop:merge-failed and are the only remaining work. Repair each adoption named in its comment, remove loop:merge-failed and any loop:merge-ready, add loop:ready, and restart the loop.'

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'decisions.txt'), 'utf8')).toBe(`${reason}\n`)
    expect(logText()).toContain(`ERROR ${reason}`)
    expect(logText()).not.toContain('Waiting remote')
  })

  it('stops with the repair when a failure relabel left merge-ready beside merge-failed', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'half-relabelled adoption', body: '',
      labels: [LABEL_FINDING, LABEL_MERGE_READY, 'loop:merge-failed'],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(logText()).toContain('ERROR Issues #1 are labelled loop:merge-failed')
    expect(logText()).not.toContain('Waiting remote')
  })

  it('keeps waiting on a merge-failed issue while other remote work is active', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'adoption needs repair', body: '', labels: [LABEL_FINDING, 'loop:merge-failed'],
    })
    await fakeForge.createIssue({
      title: 'still running', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toBe('Waiting remote      issues #1 #2')
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

  it('does not exempt an ancestral merge marker written by an outsider', async () => {
    const mergeSha = git(['rev-parse', 'HEAD'])
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'forged merged fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    await fakeForge.commentIssue(
      issueNumber,
      `MERGED: forged-task\nMerged as ${mergeSha} into run branch feature/run-9. This issue closes on promotion.`,
    )
    fakeForge.issueCommentAuthors.set(issueNumber, [
      { login: 'outside-user', hasWriteAccess: false },
    ])

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
  })

  it('does not exempt a merge marker with no parseable SHA', async () => {
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'unverifiable merged fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    await fakeForge.commentIssue(issueNumber, 'MERGED: remote-task\nMerged by another checkout.')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
  })

})

describe('documentation findings held for the cycle', () => {
  const heldFile = (): string => join(paths.queueDir, 'held-documentation.txt')
  const heldRecords = (): string[] => existsSync(heldFile())
    ? readFileSync(heldFile(), 'utf8').split(/\r?\n/).filter((line) => line !== '')
    : []
  const suiteRuns = (): boolean => existsSync(join(repoRoot, 'suite-runs'))
  const taskIdsNow = (): string[] => readdirSync(paths.tasksDir).map((name) => name.replace(/\.md$/, ''))
  const gatedProject: ProjectAdapter = {
    ...stubProject,
    cycleSuite: () => [{
      label: 'Marker', cwd: '',
      command: `node -e "require('node:fs').appendFileSync('suite-runs', 'run\\n')"`,
    }],
  }
  const gateConfig: Partial<LoopConfig> = {
    taskGate: 'light', autoPr: false, ciGateEnabled: false, reviewEnabled: true, autoReview: false,
  }

  beforeEach(() => {
    mkdirSync(join(paths.root, 'templates', 'pitfalls'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'pitfalls', 'docs.md'), 'Project documentation pitfalls.\n')
    writeFileSync(join(paths.root, 'templates', 'task-requirements.md'), 'Shared requirements.\n')
  })

  it('starts code at once and releases the documentation as one numbered task after it merges', async () => {
    useFakeRepository()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop(gateConfig, gatedProject)
    const scanId = '20250101_000000_030_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))

    const dispatch = await loop.scanForNextTasks(scanId, 0)

    expect(dispatch.findings).toHaveLength(3)
    const [bugId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(readFileSync(specFile(paths, bugId!), 'utf8')).toContain('[BUG] `src/parse.ts` drops the last line')
    expect(backlogEntries()).toEqual([`${bugId}:1`])
    expect(heldRecords()).toEqual([
      `1\t${scanId}\t[DOCS] \`README.md\` names a removed flag`,
      `1\t${scanId}\t[DOCS] \`SPEC.md\` misstates the retry bound`,
    ])
    expect(logged).toContain(
      "Deferred 030_scan    2 documentation finding(s) until the cycle's other tasks finish",
    )

    // While the code task is queued, running, or awaiting its merge, nothing is released.
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    writeRawStatus(bugId!, 'running')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    writeRawStatus(bugId!, 'completed')
    writeFileSync(join(paths.queueDir, 'scanned', bugId!), '')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(taskIdsNow()).toEqual([bugId])
    expect(heldRecords()).toHaveLength(2)
    expect(suiteRuns()).toBe(false)

    writeRawStatus(bugId!, 'merged')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    const docsId = taskIdsNow().find((taskId) => taskId !== bugId)
    expect(taskIdsNow()).toHaveLength(2)
    expect(backlogEntries()).toEqual([`${docsId}:1`])
    const spec = readFileSync(specFile(paths, docsId!), 'utf8')
    expect(spec).toContain([
      '## Requirement',
      '',
      '1. [DOCS] `README.md` names a removed flag',
      '2. [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    expect(spec).toContain('Project documentation pitfalls.')
    expect(heldRecords()).toEqual([])
    expect(logged).toContain('Released docs        2 documentation finding(s) as one task')
    expect(suiteRuns()).toBe(false)

    // The cycle closes only once the documentation task is terminal.
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    writeRawStatus(docsId!, 'running')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(suiteRuns()).toBe(false)
    writeRawStatus(docsId!, 'merged')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\n')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(taskIdsNow()).toHaveLength(2)
  })

  it('releases a single held finding without numbering it', async () => {
    const loop = makeLoop()
    const scanId = '20250101_000000_031_scan'
    writeFinal(scanId, 'NEXT_TASK: [DOCS] `README.md` omits the cleanup command\n')
    await loop.scanForNextTasks(scanId, 0)
    expect(taskIdsNow()).toEqual([])
    expect(logged).toContain(
      "Deferred 031_scan    1 documentation finding(s) until the cycle's other tasks finish",
    )

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    const [docsId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(docsId).toContain('_auto-')
    const spec = readFileSync(specFile(paths, docsId!), 'utf8')
    expect(spec).toContain(
      `## Auto-generated task (parent: ${scanId})\n\n[DOCS] \`README.md\` omits the cleanup command\n`,
    )
    expect(spec).not.toContain('1. [DOCS]')
    expect(backlogEntries()).toEqual([`${docsId}:1`])
    expect(logged).toContain('Released docs        1 documentation finding(s) as one task')
  })

  it('holds and releases a documentation finding with interior line separator characters', async () => {
    const loop = makeLoop()
    const scanId = '20250101_000000_036_scan'
    const lineSeparator = String.fromCodePoint(0x2028)
    const paragraphSeparator = String.fromCodePoint(0x2029)
    const finding = `[DOCS] README.md names${lineSeparator}a removed${paragraphSeparator}flag in\rthe cleanup section`
    writeFinal(scanId, `NEXT_TASK: ${finding}\n`)

    await loop.scanForNextTasks(scanId, 0)
    expect(taskIdsNow()).toEqual([])
    expect(heldRecords()).toEqual([`1\t${scanId}\t${finding}`])

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    const [docsId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(readFileSync(specFile(paths, docsId!), 'utf8')).toContain(finding)
    expect(heldRecords()).toEqual([])
    expect(logged).toContain('Released docs        1 documentation finding(s) as one task')
  })

  it('counts a documentation-only scan as a finding scan and releases it when nothing else is open', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeFileSync(join(paths.queueDir, 'scan-expected-1'), '1\n')
    writeFileSync(join(paths.queueDir, 'empty-scan-count.txt'), '2\n')
    const loop = makeLoop(gateConfig, gatedProject)
    const scanId = '20250101_000000_032_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))

    await loop.scanForNextTasks(scanId, 0)
    loop.recordScanYield(scanId)

    expect(readFileSync(join(paths.queueDir, 'scan-yield-1'), 'utf8')).toBe(`${scanId}\tfound\n`)
    expect(taskIdsNow()).toEqual([])
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(taskIdsNow()).toHaveLength(1)
    expect(suiteRuns()).toBe(false)
    loop.foldScanYields(1)
    expect(readFileSync(join(paths.queueDir, 'empty-scan-count.txt'), 'utf8').trim()).toBe('0')
  })

  it('holds a documentation finding reported by two scans once', async () => {
    const loop = makeLoop()
    const finding = '[DOCS] `README.md` names a removed flag'
    writeFinal('20250101_000000_033_scan', `NEXT_TASK: ${finding}\n`)
    writeFinal('20250101_000000_034_scan', `NEXT_TASK: ${finding}\nNEXT_TASK: ${finding}\n`)

    await loop.scanForNextTasks('20250101_000000_033_scan', 0)
    await loop.scanForNextTasks('20250101_000000_034_scan', 0)

    expect(heldRecords()).toEqual([`1\t20250101_000000_033_scan\t${finding}`])
    expect(logged.filter((line) => line.startsWith('Deferred'))).toHaveLength(1)

    // Once released, the task carrying it suppresses the same finding as any task would.
    await loop.triggerScanIfIdle()
    expect(taskIdsNow()).toHaveLength(1)
    writeFinal('20250101_000000_035_scan', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_035_scan', 0)
    expect(heldRecords()).toEqual([])
    expect(taskIdsNow()).toHaveLength(1)
  })

  it('keeps the holding file across a restart and clears it when a new run starts', async () => {
    const repository = useFakeRepository()
    const loop = makeLoop()
    loop.initializeSessionStateForBranch()
    writeFinal('20250101_000000_036_scan', 'NEXT_TASK: [DOCS] `README.md` names a removed flag\n')
    await loop.scanForNextTasks('20250101_000000_036_scan', 1)

    const restarted = makeLoop()
    restarted.initializeSessionStateForBranch()
    expect(heldRecords()).toEqual([
      '2\t20250101_000000_036_scan\t[DOCS] `README.md` names a removed flag',
    ])
    expect(await restarted.triggerScanIfIdle()).toBe('continue')
    const [docsId] = taskIdsNow()
    expect(backlogEntries()).toEqual([`${docsId}:2`])

    writeFinal('20250101_000000_037_scan', 'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound\n')
    await restarted.scanForNextTasks('20250101_000000_037_scan', 0)
    expect(heldRecords()).toHaveLength(1)
    repository.state.branch = 'feature/next-run'
    repository.state.branches.push('feature/next-run')
    makeLoop().initializeSessionStateForBranch()
    expect(existsSync(heldFile())).toBe(false)
  })

  it('drops held findings with the task-limit warning when the combined task has no capacity', async () => {
    useFakeRepository()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, maxTotalTasks: 1 }, gatedProject)
    writeFinal('20250101_000000_038_scan', [
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_038_scan', 0)
    const [bugId] = taskIdsNow()
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    writeRawStatus(bugId!, 'merged')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logText()).toContain('WARN task limit 1 ignored findings from 038_scan')
    expect(heldRecords()).toEqual([])
    expect(taskIdsNow()).toEqual([bugId])
    expect(suiteRuns()).toBe(true)
  })

  it('drops held findings with the depth-limit warning when their depth exceeds the bound', async () => {
    useFakeRepository()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    // Recorded under a run whose bound allowed depth 2; the restarted loop allows only 1.
    writeFileSync(heldFile(), [
      '1\t20250101_000000_040_scan\t[DOCS] `README.md` names a removed flag',
      '2\t20250101_000000_040_scan\t[DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n') + '\n')
    const loop = makeLoop({ ...gateConfig, maxGrowthDepth: 1 }, gatedProject)

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logText()).toContain('WARN growth depth limit 1 ignored findings from 040_scan')
    expect(logText()).not.toContain('Released')
    expect(heldRecords()).toEqual([])
    expect(taskIdsNow()).toEqual([])
    expect(backlogEntries()).toEqual([])
    expect(suiteRuns()).toBe(true)
  })

  it('leaves a cycle without documentation findings as it was', async () => {
    useFakeRepository()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop(gateConfig, gatedProject)
    writeFinal('20250101_000000_039_scan', [
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
      'NEXT_TASK: [TEST] `src/parse.test.ts` lacks a trailing-line case',
    ].join('\n'))

    await loop.scanForNextTasks('20250101_000000_039_scan', 0)

    expect(taskIdsNow()).toHaveLength(2)
    expect(backlogEntries()).toHaveLength(2)
    expect(existsSync(heldFile())).toBe(false)
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    for (const taskId of taskIdsNow()) writeRawStatus(taskId, 'merged')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(suiteRuns()).toBe(true)
    expect(taskIdsNow()).toHaveLength(2)
    expect(logText()).not.toMatch(/Deferred|Released/)
  })

  it('files the held findings as one issue with every fingerprint once the other issues close', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    writeFinal('20250101_000000_040_scan', [
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))

    await loop.scanForNextTasks('20250101_000000_040_scan', 0)

    expect([...fakeForge.issues.values()].map((issue) => issue.title))
      .toEqual(['[BUG] `src/parse.ts` drops the last line'])
    expect(heldRecords()).toHaveLength(2)
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)

    await fakeForge.closeIssue(1, 'fixed')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(fakeForge.issues.size).toBe(2)
    const combined = await fakeForge.getIssue(2)
    expect(combined.title).toBe('Documentation fixes (cycle 1)')
    expect(combined.body).toContain([
      '1. [DOCS] `README.md` names a removed flag',
      '2. [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    expect(combined.body.match(/^Fingerprint: /gm)).toHaveLength(2)
    expect(combined.body).toContain('Depth: 1')
    expect(heldRecords()).toEqual([])
    expect(suiteRuns()).toBe(false)
  })

  it('keeps the held findings and waits when filing their issue fails, then files them once', async () => {
    useFakeRepository()
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const scanId = '20250101_000000_047_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    await loop.scanForNextTasks(scanId, 0)
    const held = heldRecords()
    expect(held).toEqual([
      `1\t${scanId}\t[DOCS] \`README.md\` names a removed flag`,
      `1\t${scanId}\t[DOCS] \`SPEC.md\` misstates the retry bound`,
    ])

    const createIssue = fakeForge.createIssue.bind(fakeForge)
    fakeForge.createIssue = async () => {
      throw new Error('temporary publication failure')
    }
    expect(await loop.poll()).toBe('continue')

    expect(fakeForge.issues.size).toBe(0)
    expect(heldRecords()).toEqual(held)
    expect(logText()).toContain(
      'WARN could not file held documentation findings: temporary publication failure',
    )
    expect(logged).toContain('Idle Status      Task=0  Queue=0  0s  Waiting=documentation release')
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(suiteRuns()).toBe(false)

    fakeForge.createIssue = createIssue
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(fakeForge.issues.size).toBe(1)
    const combined = await fakeForge.getIssue(1)
    expect(combined.title).toBe('Documentation fixes (cycle 1)')
    expect(combined.body).toContain([
      '1. [DOCS] `README.md` names a removed flag',
      '2. [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    expect(heldRecords()).toEqual([])
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([
      'Released docs        2 documentation finding(s) as one task',
    ])
    expect(suiteRuns()).toBe(false)

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    expect(logged.filter((line) => line.startsWith('Released'))).toHaveLength(1)
  })

  it('keeps the held findings and waits when the local enqueue fails, then releases them once', async () => {
    useFakeRepository()
    let failEnqueue = true
    const loop = makeLoop(
      gateConfig, gatedProject, undefined, () => new Date(2026, 7, 8, 12, 0, 0), makeRunner(),
      (queuePaths, taskId, depth) => {
        if (failEnqueue) throw new Error('temporary local queue failure')
        return enqueueTask(queuePaths, taskId, depth)
      },
    )
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const scanId = '20250101_000000_048_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    await loop.scanForNextTasks(scanId, 0)
    const held = heldRecords()
    expect(held).toHaveLength(2)

    expect(await loop.poll()).toBe('continue')

    expect(backlogEntries()).toEqual([])
    expect(heldRecords()).toEqual(held)
    expect(logText()).toContain(
      'WARN could not enqueue finding from 048_scan: temporary local queue failure',
    )
    expect(logged).toContain('Idle Status      Task=0  Queue=0  0s  Waiting=documentation release')
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(suiteRuns()).toBe(false)

    failEnqueue = false
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    const [docsId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(backlogEntries()).toEqual([`${docsId}:1`])
    expect(readFileSync(specFile(paths, docsId!), 'utf8')).toContain([
      '## Requirement',
      '',
      '1. [DOCS] `README.md` names a removed flag',
      '2. [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    expect(heldRecords()).toEqual([])
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([
      'Released docs        2 documentation finding(s) as one task',
    ])
    expect(suiteRuns()).toBe(false)

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(taskIdsNow()).toEqual([docsId])
    expect(backlogEntries()).toEqual([`${docsId}:1`])
    expect(logged.filter((line) => line.startsWith('Released'))).toHaveLength(1)
  })

  it('warns without stopping when a release fails after the scan that held it recovered', async () => {
    useFakeRepository()
    let failEnqueue = true
    const loop = makeLoop(
      gateConfig, gatedProject, undefined, () => new Date(2026, 7, 8, 12, 0, 0), makeRunner(),
      (queuePaths, taskId, depth) => {
        if (failEnqueue) throw new Error('temporary local queue failure')
        return enqueueTask(queuePaths, taskId, depth)
      },
    )
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const scanId = '20250101_000000_049_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
    ].join('\n'))

    expect((await loop.scanForNextTasks(scanId, 0)).reconciled).toBe(false)
    expect(logText()).toContain(
      'WARN could not enqueue finding from 049_scan: temporary local queue failure',
    )

    failEnqueue = false
    expect((await loop.scanForNextTasks(scanId, 0)).reconciled).toBe(true)
    const [bugId] = taskIdsNow()
    expect(backlogEntries()).toEqual([`${bugId}:1`])
    expect(heldRecords()).toHaveLength(1)

    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    writeRawStatus(bugId!, 'merged')
    failEnqueue = true
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(heldRecords()).toHaveLength(1)
    expect(logText().match(/WARN could not enqueue finding from 049_scan/g)).toHaveLength(2)
    expect(logText()).not.toContain('ERROR could not enqueue finding')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    failEnqueue = false
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(heldRecords()).toEqual([])
    expect(logged).toContain('Released docs        1 documentation finding(s) as one task')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('does not file held findings again when listing fails after their issue was created', async () => {
    useFakeRepository()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    let current = new Date(2026, 7, 11, 14, 0, 0)
    const resetAt = new Date(2026, 7, 11, 14, 40, 0)
    const loop = makeLoop(
      { ...gateConfig, issueQueueEnabled: true }, gatedProject, undefined, () => current,
    )
    writeFinal('20250101_000000_042_scan', [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_042_scan', 0)
    expect(heldRecords()).toHaveLength(2)

    // The forge creates the combined issue, then rate-limits the listing that follows.
    const listOpenIssues = fakeForge.listOpenIssues.bind(fakeForge)
    let limited = false
    fakeForge.listOpenIssues = async (label) => {
      if (fakeForge.issues.size === 1 && !limited) {
        limited = true
        throw new ForgeRateLimitError(resetAt)
      }
      return listOpenIssues(label)
    }
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(limited).toBe(true)
    expect(fakeForge.issues.size).toBe(1)
    expect(heldRecords()).toHaveLength(2)

    // Once the limit clears, the gate waits on the open, unmerged issue.
    current = new Date(2026, 7, 11, 14, 41, 0)
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    expect(heldRecords()).toHaveLength(2)
    expect(logged).toContain('Waiting remote      issues #1')

    // Merged into the run branch, the open issue already carries every held finding.
    recordIssuesForTask(paths, 'docs-task', [1])
    recordIssuePromotions(paths, 'docs-task', 'abc123', 'feature/run-1')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    expect(existsSync(heldFile())).toBe(false)
    expect(logged).toContain(
      'Deduplicated docs        2 held documentation finding(s) already carried by an open issue',
    )
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([])

    await fakeForge.closeIssue(1, 'promoted')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    expect(existsSync(heldFile())).toBe(false)
  })

  it('releases only the held finding that no open issue carries', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    const scanId = '20250101_000000_043_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    await loop.scanForNextTasks(scanId, 0)
    expect(heldRecords()).toHaveLength(2)
    // An earlier release of this holding file filed the first finding; its fix merged.
    const covering = await fakeForge.createIssue({
      title: 'merged documentation fix',
      body: buildIssueBody('[DOCS] `README.md` names a removed flag', scanId),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, 'other-task', [covering])
    recordIssuePromotions(paths, 'other-task', 'abc123', 'feature/run-1')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logged).toContain(
      'Deduplicated docs        1 held documentation finding(s) already carried by an open issue',
    )
    expect(fakeForge.issues.size).toBe(2)
    const released = await fakeForge.getIssue(covering + 1)
    expect(released.title).toBe('[DOCS] `SPEC.md` misstates the retry bound')
    expect(released.body).not.toContain('README.md')
    expect(released.body.match(/^Fingerprint: /gm)).toHaveLength(1)
    expect(heldRecords()).toEqual([])
    expect(logged).toContain('Released docs        1 documentation finding(s) as one task')
  })

  it('files a finding observed again after its earlier fix merged and awaits promotion', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    const finding = '[DOCS] `README.md` names a removed flag'
    writeFinal('20250101_000000_045_scan', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_045_scan', 0)
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    const first = await fakeForge.getIssue(1)
    expect(first.body).toContain('Parent: 20250101_000000_045_scan')
    expect(heldRecords()).toEqual([])
    recordIssuesForTask(paths, 'docs-task', [1])
    recordIssuePromotions(paths, 'docs-task', 'abc123', 'feature/run-1')

    // The first fix was incomplete: a later scan reports the same finding again.
    writeFinal('20250101_000000_046_scan', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_046_scan', 0)
    expect(heldRecords()).toEqual([`1\t20250101_000000_046_scan\t${finding}`])
    expect(logged).toContain(
      "Deferred 046_scan    1 documentation finding(s) until the cycle's other tasks finish",
    )

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logged.filter((line) => line.startsWith('Deduplicated'))).toEqual([])
    expect(fakeForge.issues.size).toBe(2)
    const second = await fakeForge.getIssue(2)
    expect(second.title).toBe(finding)
    expect(second.body).toContain('Parent: 20250101_000000_046_scan')
    expect(second.body.match(/^Fingerprint: .*$/m)?.[0]).toBe(first.body.match(/^Fingerprint: .*$/m)?.[0])
    expect(heldRecords()).toEqual([])
  })

  it('does not count an open issue from an author without write access as coverage', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    const finding = '[DOCS] `README.md` names a removed flag'
    writeFinal('20250101_000000_044_scan', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_044_scan', 0)
    expect(heldRecords()).toHaveLength(1)
    const outside = await fakeForge.createIssue({
      title: 'outside documentation claim',
      body: buildIssueBody(finding, 'outside'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    fakeForge.issues.get(outside)!.author = { login: 'drive-by-user', hasWriteAccess: false }
    recordIssuesForTask(paths, 'outside-task', [outside])
    recordIssuePromotions(paths, 'outside-task', 'abc123', 'feature/run-1')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logged.filter((line) => line.startsWith('Deduplicated'))).toEqual([])
    expect(fakeForge.issues.size).toBe(2)
    expect((await fakeForge.getIssue(outside + 1)).title).toBe(finding)
    expect(heldRecords()).toEqual([])
  })

  it('leaves the findings of a review task on their combined path', async () => {
    const loop = makeLoop()
    writeFinal('20250101_000000_041_review-c1', [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
    ].join('\n'))

    await loop.scanForNextTasks('20250101_000000_041_review-c1', 0)

    expect(existsSync(heldFile())).toBe(false)
    const [fixId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(fixId).toContain('_fix-')
    expect(readFileSync(specFile(paths, fixId!), 'utf8')).toContain([
      '## Requirement',
      '',
      '1. [DOCS] `README.md` names a removed flag',
      '2. [BUG] `src/parse.ts` drops the last line',
    ].join('\n'))
    expect(backlogEntries()).toEqual([`${fixId}:1`])
  })
})
