// Which suites a platform cannot attempt, and the one place that knows it.
//
// `vitest.config.ts` reads this to leave them uncollected, and `globalSetup` reads it to
// say so at the start of a run. Both from here, so a suite added to one is never missing
// from the other: a file silently uncollected reports the same summary as one that does
// not exist, and a reader cannot tell a run that skipped nothing from a run that skipped
// something without saying so.

export interface PlatformSuite {
  file: string
  platform: NodeJS.Platform
  reason: string
}

export const PLATFORM_SUITES: PlatformSuite[] = [
  {
    file: 'tests/windows-console.test.ts',
    platform: 'win32',
    reason: 'launches a Windows process tree and observes the consoles it attaches',
  },
  {
    file: 'tests/windows-run-tests-cancellation.test.ts',
    platform: 'win32',
    reason: 'launches PowerShell and verifies Windows process-tree cancellation',
  },
  {
    file: 'tests/posix-process-group.test.ts',
    platform: 'linux',
    reason: 'signals a real detached process group and reads /proc to see who survived',
  },
]

/** The suites this platform cannot attempt, so the config can leave them uncollected. */
export function uncollectedSuites(platform: NodeJS.Platform = process.platform): string[] {
  return PLATFORM_SUITES.filter((suite) => suite.platform !== platform).map((s) => s.file)
}

/** What a run should state about the suites its platform does and does not cover. */
export function platformCoverageReport(
  platform: NodeJS.Platform = process.platform,
): string {
  const collected = PLATFORM_SUITES.filter((suite) => suite.platform === platform)
  const uncollected = PLATFORM_SUITES.filter((suite) => suite.platform !== platform)
  const lines = [`platform ${platform}: ${PLATFORM_SUITES.length} platform-specific suite(s)`]
  for (const suite of collected) lines.push(`  collected  ${suite.file}`)
  for (const suite of uncollected) {
    lines.push(`  not run    ${suite.file} — needs ${suite.platform}: ${suite.reason}`)
  }
  return lines.join('\n')
}
