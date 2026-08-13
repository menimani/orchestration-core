import { describe, expect, it } from 'vitest'
import { coreProject } from '../orchestration/project/project-core.ts'

const ENGLISH_ONLY = 'node checks/english-only.ts'

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
})
