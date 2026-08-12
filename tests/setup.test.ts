import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderProjectAdapter } from '../src/adapters/project.ts'
import { QUEUE_LABELS } from '../src/issueQueue.ts'
import { orchPaths } from '../src/paths.ts'
import { verifyRepositorySetup } from '../src/setup.ts'
import { makeFakeForge } from './fakeForge.ts'

const repositories: string[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true })
  }
})

describe('setup verification', () => {
  it('uses the real loader and reports every setup check', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'orchestration-verify-'))
    repositories.push(repository)
    const packageRoot = join(repository, 'orchestration', 'ts')
    mkdirSync(join(packageRoot, '.githooks'), { recursive: true })
    const projectDirectory = join(repository, 'orchestration', 'project')
    mkdirSync(projectDirectory, { recursive: true })
    const adapter = renderProjectAdapter('consumer', '../ts/src/adapters/project.ts')
      .replace('cycleSuite: () => []', "cycleSuite: () => [{ label: 'Consumer suite', cwd: '', command: 'test' }]")
    writeFileSync(join(projectDirectory, 'project-consumer.ts'), adapter)
    const forge = makeFakeForge()
    for (const label of QUEUE_LABELS) forge.labels.add(label.name)
    const reports: string[] = []
    const git = (args: string[]): string => {
      if (args.includes('@{upstream}')) return 'origin/topic'
      if (args.includes('core.hooksPath')) return 'orchestration/ts/.githooks'
      if (args.includes('--dry-run')) return ''
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    }

    const ok = await verifyRepositorySetup(orchPaths(repository), forge, {
      packageRoot,
      report: (line) => reports.push(line),
      git,
      run: () => true,
    })

    expect(ok).toBe(true)
    expect(reports).toEqual([
      'PASS: orchestration TypeScript typecheck',
      "PASS: loadProject discovered adapter 'consumer' by name",
      "PASS: adapter suite step 'Consumer suite'",
      'PASS: adapter suite',
      'PASS: all 0 adapter-referenced paths exist',
      'PASS: current branch can push to origin/topic',
      'PASS: core.hooksPath is orchestration/ts/.githooks',
      'PASS: all 6 loop labels exist',
    ])
  })
})
