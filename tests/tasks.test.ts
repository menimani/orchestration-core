import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import {
  buildIssueBody, issueNumberForTask, parseIssueBody,
  LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_READY,
} from '../src/issueQueue.ts'
import {
  delegateTask, delegateTaskVisible, enqueueTask, isIssueModeActive, isLoopRunning, newTaskSpec,
  removeIssueModeMarker, specFile, writeIssueModeMarker,
} from '../src/tasks.ts'
import { makeFakeForge } from './fakeForge.ts'

let repoRoot: string
let paths: OrchPaths

function queueLines(): string[] {
  const backlog = join(paths.queueDir, 'backlog.txt')
  if (!existsSync(backlog)) return []
  return readFileSync(backlog, 'utf8').split(/\r?\n/).filter((line) => line !== '')
}

function createSpec(taskId: string): void {
  writeFileSync(specFile(paths, taskId), '# Test task\n')
}

function writeTestStatus(taskId: string, status: string): void {
  writeFileSync(join(paths.statusDir, `${taskId}.json`), JSON.stringify({ task_id: taskId, status }))
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-tasks-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('enqueueTask', () => {
  it('leaves exactly one entry for a duplicate enqueue', () => {
    createSpec('duplicate-task')
    enqueueTask(paths, 'duplicate-task')
    const second = enqueueTask(paths, 'duplicate-task')
    expect(second.outcome).toBe('already-queued')
    expect(queueLines()).toEqual(['duplicate-task:0'])
  })

  it.each(['merged', 'running', 'completed'])('skips a task whose status is %s', (status) => {
    const taskId = `${status}-task`
    createSpec(taskId)
    writeTestStatus(taskId, status)
    const result = enqueueTask(paths, taskId)
    expect(result.outcome).toBe('already-processed')
    expect(queueLines()).toEqual([])
  })

  it('enqueues a failed task for retry at the default depth', () => {
    createSpec('failed-task')
    writeTestStatus('failed-task', 'failed')
    const result = enqueueTask(paths, 'failed-task')
    expect(result.outcome).toBe('enqueued')
    expect(queueLines()).toEqual(['failed-task:0'])
  })

  it('rejects a task without a specification', () => {
    expect(() => enqueueTask(paths, 'missing-task')).toThrow(/specification not found/i)
  })
})

describe('delegateTask', () => {
  const DESC = 'Add an index on event.artist_id and prove it with the existing repository test'

  beforeEach(() => {
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(
      join(paths.root, 'templates', 'task-requirements.md'),
      '## Before reporting this done\n\n- Run the tests.\n',
    )
  })

  it('creates a spec and enqueues exactly one task at depth 0', () => {
    const result = delegateTask(paths, DESC)
    expect(queueLines()).toHaveLength(1)
    expect(result.taskId).toMatch(/^\d{8}_\d{6}_\d{3}_user-/)
    expect(queueLines()[0]).toBe(`${result.taskId}:0`)

    const spec = readFileSync(result.spec, 'utf8')
    expect(spec).toContain(DESC)
    expect(spec).toMatch(/^## Before reporting this done$/m)
    const lines = spec.trimEnd().split('\n')
    expect(lines[lines.length - 1]).toBe('TASK_COMPLETE')
  })

  it('resolves the same description to the one existing task and spec', () => {
    delegateTask(paths, DESC)
    delegateTask(paths, DESC)
    expect(queueLines()).toHaveLength(1)
    expect(readdirSync(paths.tasksDir)).toHaveLength(1)
  })

  it('writes the effort override file for --effort', () => {
    delegateTask(paths, 'Rename the expense label helper for clarity', { effort: 'high' })
    const effortDir = join(paths.queueDir, 'effort')
    const files = readdirSync(effortDir)
    expect(files).toHaveLength(1)
    expect(readFileSync(join(effortDir, files[0] as string), 'utf8').trim()).toBe('high')
  })

  it('writes the inspect marker for --inspect', () => {
    const result = delegateTask(paths, 'Report which pages skip the layout component', { inspect: true })
    expect(existsSync(join(paths.queueDir, 'inspect', result.taskId))).toBe(true)
  })

  it('rejects a blank description', () => {
    expect(() => delegateTask(paths, '   ')).toThrow(/description/i)
  })

  it('publishes delegated work as ready for the daemon when its marker enables issues', async () => {
    writeIssueModeMarker(paths, true)
    const forge = makeFakeForge('delegator')
    const result = await delegateTaskVisible(paths, DESC, { effort: 'high', inspect: true }, {
      env: {},
      loadForge: async () => forge,
      warn: () => {},
    })

    expect(queueLines()).toEqual([])
    expect(result.issue).toEqual({ outcome: 'created', issueNumber: 1, materialize: false })
    expect(issueNumberForTask(paths, result.taskId)).toBeUndefined()
    const issue = await forge.getIssue(1)
    expect(issue.labels).toEqual([LABEL_FINDING, LABEL_READY])
    expect(issue.assignees).toEqual([])
    expect(parseIssueBody(issue.body, issue.number))
      .toMatchObject({ effort: 'high', inspect: true })
    // The publication never touches the backlog, so the daemon's watcher needs this
    // nudge — without it the issue waits out the full poll interval.
    expect(existsSync(join(paths.queueDir, 'wake'))).toBe(true)
  })

  it('ignores an issue-mode marker whose daemon is no longer alive', () => {
    writeIssueModeMarker(paths, true, 2147483647)

    expect(isIssueModeActive(paths, {})).toBe(false)
  })

  it('uses the operating-system liveness verdict for daemon markers', () => {
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    writeIssueModeMarker(paths, true, 2147483647)
    writeFileSync(join(paths.queueDir, 'loop.pid'), '2147483646\n')

    expect(isIssueModeActive(paths, {})).toBe(true)
    expect(isLoopRunning(paths)).toBe(true)
    expect(processIsAlive).toHaveBeenNthCalledWith(1, 2147483647)
    expect(processIsAlive).toHaveBeenNthCalledWith(2, 2147483646)
  })

  it('removes only the issue-mode marker owned by the exiting daemon', () => {
    const marker = join(paths.queueDir, 'issue-mode')
    writeIssueModeMarker(paths, true, 123)

    removeIssueModeMarker(paths, 456)
    expect(existsSync(marker)).toBe(true)

    removeIssueModeMarker(paths, 123)
    expect(existsSync(marker)).toBe(false)
  })

  it('leaves a ready matching issue for the daemon without creating local work', async () => {
    const description = '[BUG] `src/a/b.ts` breaks delegated work'
    const forge = makeFakeForge('delegator')
    const issueNumber = await forge.createIssue({
      title: description,
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    forge.assignIssue = async () => { throw new Error('delegate must not claim') }

    const result = await delegateTaskVisible(paths, description, {}, {
      env: { ISSUE_QUEUE_ENABLED: 'true' },
      loadForge: async () => forge,
      warn: () => {},
    })

    expect(result.issue).toEqual({ outcome: 'duplicate', issueNumber, materialize: false })
    expect(queueLines()).toEqual([])
    expect(readdirSync(paths.tasksDir)).toEqual([])
    const issue = await forge.getIssue(issueNumber)
    expect(issue.assignees).toEqual([])
    expect(issue.labels).toEqual([LABEL_FINDING, LABEL_READY])
  })

  it('does not materialize a task when another worker already claimed its fingerprint', async () => {
    const description = '[BUG] `src/a/b.ts` breaks delegated work'
    const forge = makeFakeForge('delegator')
    const issueNumber = await forge.createIssue({
      title: description,
      body: buildIssueBody(description, 'worker-task'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-busy'],
    })

    const result = await delegateTaskVisible(paths, description, {}, {
      env: { ISSUE_QUEUE_ENABLED: 'true' },
      loadForge: async () => forge,
      warn: () => {},
    })

    expect(result.issue).toEqual({ outcome: 'duplicate', issueNumber, materialize: false })
    expect(result.enqueue).toBeUndefined()
    expect(queueLines()).toEqual([])
    expect(existsSync(result.spec)).toBe(false)
    expect(readdirSync(paths.tasksDir)).toEqual([])
    expect(issueNumberForTask(paths, result.taskId)).toBeUndefined()
  })

  it('still enqueues locally when forge publication fails', async () => {
    const warnings: string[] = []
    const result = await delegateTaskVisible(paths, DESC, {}, {
      env: { ISSUE_QUEUE_ENABLED: 'true' },
      loadForge: async () => { throw new Error('forge unavailable') },
      warn: (message) => warnings.push(message),
    })

    expect(queueLines()).toEqual([`${result.taskId}:0`])
    expect(result.issue).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('forge unavailable')])
  })

  it('does not fall back locally when issue creation may have succeeded remotely', async () => {
    const forge = makeFakeForge('delegator')
    const createIssue = forge.createIssue.bind(forge)
    forge.createIssue = async (issue) => {
      await createIssue(issue)
      throw new Error('response lost after creation')
    }

    await expect(delegateTaskVisible(paths, DESC, {}, {
      env: { ISSUE_QUEUE_ENABLED: 'true' },
      loadForge: async () => forge,
      warn: () => {},
    })).rejects.toThrow(/may have been published/i)

    expect(forge.issues.size).toBe(1)
    expect(queueLines()).toEqual([])
    expect(readdirSync(paths.tasksDir)).toEqual([])
  })

  it('does not need a forge identity to publish for the daemon', async () => {
    const description = '[BUG] `src/a/b.ts` is delegated through the daemon'
    const forge = makeFakeForge('delegator')
    forge.currentUser = async () => { throw new Error('identity lookup must not run') }

    const result = await delegateTaskVisible(paths, description, {}, {
      env: { ISSUE_QUEUE_ENABLED: 'true' },
      loadForge: async () => forge,
      warn: () => {},
    })

    expect(result.issue).toEqual({ outcome: 'created', issueNumber: 1, materialize: false })
    expect(queueLines()).toEqual([])
    expect(readdirSync(paths.tasksDir)).toEqual([])
    expect(existsSync(join(paths.queueDir, 'issue-map'))).toBe(false)
  })

  it('files nothing when the delegate environment explicitly disables issue mode', async () => {
    writeIssueModeMarker(paths, true)
    let loadedForge = false
    const result = await delegateTaskVisible(paths, DESC, {}, {
      env: { ISSUE_QUEUE_ENABLED: 'false' },
      loadForge: async () => { loadedForge = true; return makeFakeForge() },
      warn: () => {},
    })

    expect(queueLines()).toEqual([`${result.taskId}:0`])
    expect(result.issue).toBeUndefined()
    expect(loadedForge).toBe(false)
  })
})

describe('newTaskSpec', () => {
  it('writes the template and refuses to overwrite', () => {
    const file = newTaskSpec(paths, 'manual-task')
    const spec = readFileSync(file, 'utf8')
    expect(spec).toContain('# manual-task')
    expect(spec).toContain('## Completion Criteria')
    expect(spec.trimEnd().endsWith('TASK_COMPLETE')).toBe(true)
    expect(() => newTaskSpec(paths, 'manual-task')).toThrow(/already exists/)
  })
})
