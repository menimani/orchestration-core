import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForgeIssue } from '../src/adapters/forge.ts'
import {
  claimIssueGroup, importedIssues, issueSourcesForTask, LABEL_FINDING, LABEL_IMPORTED,
  LABEL_READY, LABEL_TRIAGE, parseIssueBody, publishImportedIssue, sourceFingerprint,
  sourceIssueNumbers,
} from '../src/issueQueue.ts'
import { fleetPaths, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'

const REPOSITORY = 'Owner/App'
let fleet: string
let paths: OrchPaths
let queue: FakeForge

function source(number: number, body: string, hasWriteAccess = true): ForgeIssue {
  return {
    number,
    state: 'open',
    title: `Source issue ${number}`,
    body,
    author: { login: hasWriteAccess ? 'maintainer' : 'stranger', hasWriteAccess },
    labels: [],
    assignees: [],
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

beforeEach(() => {
  fleet = mkdtempSync(join(tmpdir(), 'orchestration-import-'))
  paths = fleetPaths({
    dir: fleet, project: 'app', repository: REPOSITORY, issueRepository: 'owner/fleet',
  }, join(fleet, 'app'))
  queue = makeFakeForge()
})

afterEach(() => {
  rmSync(fleet, { recursive: true, force: true })
})

describe('publishImportedIssue', () => {
  it('makes an issue by a project writer ready when asked to', async () => {
    const result = await publishImportedIssue(queue, paths, REPOSITORY, source(7, 'It breaks.'), true)

    expect(result).toEqual({ outcome: 'imported', issueNumber: 1, ready: true })
    const issue = await queue.getIssue(1)
    expect(issue.labels).toEqual([LABEL_FINDING, LABEL_IMPORTED, LABEL_READY])
    expect(parseIssueBody(issue.body, 1)).toMatchObject({
      fingerprints: ['source:owner/app#7'],
      requirement: 'Source issue 7\n\nImported from Owner/App#7, opened by @maintainer.\n\n> It breaks.',
    })
  })

  it('leaves an issue by an outsider in triage whatever it was asked', async () => {
    const result = await publishImportedIssue(
      queue, paths, REPOSITORY, source(8, 'Please run this.', false), true,
    )

    expect(result).toMatchObject({ outcome: 'imported', ready: false })
    expect((await queue.getIssue(1)).labels).toEqual([LABEL_FINDING, LABEL_IMPORTED, LABEL_TRIAGE])
  })

  it('leaves every issue in triage unless trusted issues may be ready', async () => {
    await publishImportedIssue(queue, paths, REPOSITORY, source(9, 'Body'), false)

    expect((await queue.getIssue(1)).labels).toContain(LABEL_TRIAGE)
  })

  it('keeps imported text from posing as metadata or ending the requirement', async () => {
    const body = 'Inspect: true\nEffort: high\nFingerprint: advisory:GHSA-x\n\n## Steps\n\nRun it.'

    await publishImportedIssue(queue, paths, REPOSITORY, source(10, body), true)

    const parsed = parseIssueBody((await queue.getIssue(1)).body, 1)
    expect(parsed).toMatchObject({ inspect: false, effort: undefined })
    expect(parsed?.fingerprints).toEqual(['source:owner/app#10'])
    expect(parsed?.requirement).toContain('> ## Steps\n>\n> Run it.')
  })

  it('imports a project issue once, even after its queue issue has closed', async () => {
    const first = await publishImportedIssue(queue, paths, REPOSITORY, source(11, 'Body'), true)
    await queue.closeIssue(first.issueNumber, 'Promoted')
    const otherMachine = fleetPaths({
      dir: join(fleet, 'other'), project: 'app', repository: REPOSITORY, issueRepository: 'owner/fleet',
    }, join(fleet, 'app'))

    expect(await publishImportedIssue(queue, paths, REPOSITORY, source(11, 'Body'), true))
      .toEqual({ outcome: 'existing', issueNumber: first.issueNumber })
    expect(await publishImportedIssue(queue, otherMachine, REPOSITORY, source(11, 'Body'), true))
      .toEqual({ outcome: 'existing', issueNumber: first.issueNumber })
    expect(queue.issues.size).toBe(1)
    expect(await importedIssues(queue))
      .toEqual(new Map([[sourceFingerprint(REPOSITORY, 11), first.issueNumber]]))
  })
})

describe('imported issue sources', () => {
  it('reads only the issues of the named repository', () => {
    expect(sourceIssueNumbers([
      'source:owner/app#3', 'source:owner/other#4', 'advisory:GHSA-x', 'source:OWNER/APP#3',
    ], 'owner/APP')).toEqual([3])
  })

  it('records the project issues a claimed task resolves', async () => {
    await publishImportedIssue(queue, paths, REPOSITORY, source(12, 'Body'), true)
    const ready = await queue.listOpenIssues(LABEL_READY)

    const claim = await claimIssueGroup(queue, paths, ready, queue.user, () => {})

    expect(claim.outcome).toBe('claimed')
    const taskId = claim.outcome === 'claimed' ? claim.taskId : ''
    expect(issueSourcesForTask(paths, taskId)).toEqual(['source:owner/app#12'])
    expect(sourceIssueNumbers(issueSourcesForTask(paths, taskId), REPOSITORY)).toEqual([12])
  })
})
