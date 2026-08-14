import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coreProject } from '../orchestration/project/project-core.ts'

const ENGLISH_ONLY = 'node checks/english-only.ts'
const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  scripts: { test: string }
}

describe('core project verification', () => {
  it('checks source language before a commit', () => {
    expect(coreProject.preCommitChecks).toContainEqual({
      label: 'English-only sources',
      cwd: '',
      command: ENGLISH_ONLY,
    })
  })

  it.each(['light', 'full'] as const)('checks source language at the %s merge gate', (gate) => {
    expect(coreProject.mergeChecks(gate)[0]?.command).toContain(ENGLISH_ONLY)
  })

  it.each(['light', 'full'] as const)('guards dependency replacement at the %s merge gate', (gate) => {
    expect(coreProject.mergeChecks(gate)[0]?.command)
      .toContain('node orchestration/project/safe-npm-ci.ts')
  })

  it('checks source language at the cycle gate', () => {
    expect(coreProject.cycleSuite()[0]?.command).toContain(ENGLISH_ONLY)
  })

  it('guards dependency replacement at the cycle gate', () => {
    expect(coreProject.cycleSuite()[0]?.command)
      .toContain('node orchestration/project/safe-npm-ci.ts')
  })

  it('leaves the merge gate as the sole source of Vitest worker flags', () => {
    expect(packageJson.scripts.test).toBe('node scripts/run-tests.mjs')
    const command = coreProject.mergeChecks('full')[0]?.command ?? ''
    expect(command.match(/--pool=threads/g)).toHaveLength(1)
    expect(command.match(/--poolOptions\.threads\.singleThread/g)).toHaveLength(1)
  })
})
