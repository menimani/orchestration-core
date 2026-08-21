import { describe, expect, it } from 'vitest'
import {
  PLATFORM_SUITES, platformCoverageReport, uncollectedSuites,
} from './platformCoverage.ts'

describe('platform coverage', () => {
  it('leaves a suite uncollected only on the platforms that cannot attempt it', () => {
    expect(uncollectedSuites('win32')).toEqual([])
    expect(uncollectedSuites('linux')).toEqual(['tests/windows-console.test.ts'])
  })

  it('names an uncollected suite and the platform it needs', () => {
    const report = platformCoverageReport('linux')
    expect(report).toContain('not run    tests/windows-console.test.ts')
    expect(report).toContain('needs win32')
    // The reason travels with the name: a reader who has never opened the file learns
    // why another platform cannot stand in for the one that runs it.
    expect(report).toContain('launches a Windows process tree')
  })

  it('reports a suite as collected on the platform that runs it', () => {
    const report = platformCoverageReport('win32')
    expect(report).toContain('collected  tests/windows-console.test.ts')
    expect(report).not.toContain('not run')
  })

  it('accounts for every platform-specific suite on both platforms', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const report = platformCoverageReport(platform)
      for (const suite of PLATFORM_SUITES) expect(report).toContain(suite.file)
    }
  })
})
