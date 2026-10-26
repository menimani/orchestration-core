import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildIssueBody, LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_READY, publishFinding, reapStaleLeases,
} from '../src/issueQueue.ts'
import type { Forge } from '../src/adapters/forge.ts'
import { projectScopeLabel, scopeForgeToProject } from '../src/issueScope.ts'
import { fleetPaths, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'

let fleet: string
let queue: FakeForge

function project(name: string): { paths: OrchPaths; label: string } {
  return {
    paths: fleetPaths(
      { dir: fleet, project: name, repository: `owner/${name}`, issueRepository: 'owner/fleet' },
      join(fleet, name),
    ),
    label: projectScopeLabel(name),
  }
}

beforeEach(() => {
  fleet = mkdtempSync(join(tmpdir(), 'orchestration-issue-scope-'))
  queue = makeFakeForge()
})

afterEach(() => {
  rmSync(fleet, { recursive: true, force: true })
})

describe('project-scoped issue queue', () => {
  it('labels every filed issue and creates the scope label once', async () => {
    const scoped = scopeForgeToProject(queue, 'project:first')

    const firstIssue = await scoped.createIssue({ title: 'one', body: 'one', labels: [LABEL_READY] })
    const secondIssue = await scoped.createIssue({ title: 'two', body: 'two', labels: [LABEL_READY] })

    expect((await queue.getIssue(firstIssue)).labels).toEqual([LABEL_READY, 'project:first'])
    expect((await queue.getIssue(secondIssue)).labels).toEqual([LABEL_READY, 'project:first'])
    expect(queue.labels).toEqual(new Set(['project:first']))
  })

  it('keeps the methods of a forge implemented as a class', async () => {
    class ClassForge {
      readonly inner: FakeForge
      constructor(inner: FakeForge) { this.inner = inner }
      currentUser(): Promise<string> { return this.inner.currentUser() }
      listLabels(): Promise<string[]> { return this.inner.listLabels() }
      createLabel(name: string, description: string): Promise<void> {
        return this.inner.createLabel(name, description)
      }
      createIssue(options: Parameters<FakeForge['createIssue']>[0]): Promise<number> {
        return this.inner.createIssue(options)
      }
      getIssue(issueNumber: number) { return this.inner.getIssue(issueNumber) }
      listOpenIssues(queueLabel: string) { return this.inner.listOpenIssues(queueLabel) }
      listClosedIssues(queueLabel: string) { return this.inner.listClosedIssues(queueLabel) }
    }
    const scoped = scopeForgeToProject(new ClassForge(queue) as unknown as Forge, 'project:first')

    const issueNumber = await scoped.createIssue({ title: 'one', body: 'one', labels: [LABEL_READY] })

    expect(await scoped.currentUser()).toBe(queue.user)
    expect((await scoped.getIssue(issueNumber)).labels).toEqual([LABEL_READY, 'project:first'])
  })

  it('lists only the issues filed by its own project', async () => {
    const first = scopeForgeToProject(queue, 'project:first')
    const second = scopeForgeToProject(queue, 'project:second')
    const mine = await first.createIssue({ title: 'mine', body: 'mine', labels: [LABEL_READY] })
    const theirs = await second.createIssue({ title: 'theirs', body: 'theirs', labels: [LABEL_READY] })
    await queue.createIssue({ title: 'unscoped', body: 'unscoped', labels: [LABEL_READY] })
    await second.closeIssue(theirs, 'done')

    expect((await first.listOpenIssues(LABEL_READY)).map((issue) => issue.number)).toEqual([mine])
    expect(await first.listClosedIssues(LABEL_READY)).toEqual([])
    expect((await second.listClosedIssues(LABEL_READY)).map((issue) => issue.number))
      .toEqual([theirs])
  })

  it('files the same finding once per project instead of deduplicating across them', async () => {
    const first = project('first')
    const second = project('second')
    const finding = '[BUG] `src/app.ts` drops the last item'

    const firstResult = await publishFinding(
      scopeForgeToProject(queue, first.label), first.paths, finding, 'scan-1',
    )
    const secondResult = await publishFinding(
      scopeForgeToProject(queue, second.label), second.paths, finding, 'scan-1',
    )

    expect(firstResult.outcome).toBe('created')
    expect(secondResult.outcome).toBe('created')
    expect(secondResult.issueNumber).not.toBe(firstResult.issueNumber)
    expect((await queue.getIssue(firstResult.issueNumber)).labels).toContain(first.label)
    expect((await queue.getIssue(secondResult.issueNumber)).labels).toContain(second.label)
  })

  it('reaps a stale claim only from the project that owns it', async () => {
    const first = project('first')
    const second = project('second')
    queue.clock = () => new Date('2026-08-08T00:00:00Z')
    const claimed = await scopeForgeToProject(queue, second.label).createIssue({
      title: 'claimed elsewhere',
      body: buildIssueBody('[BUG] `src/app.ts` claimed elsewhere', 'scan-1'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker'],
    })
    const later = new Date('2026-08-08T12:00:00Z')
    queue.clock = () => later

    expect(await reapStaleLeases(scopeForgeToProject(queue, first.label), first.paths, 3, later))
      .toEqual([])
    expect((await queue.getIssue(claimed)).assignees).toEqual(['worker'])

    expect(await reapStaleLeases(scopeForgeToProject(queue, second.label), second.paths, 3, later))
      .toEqual([claimed])
    expect((await queue.getIssue(claimed)).assignees).toEqual([])
  })
})
