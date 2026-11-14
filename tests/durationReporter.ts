import type { Reporter, TestModule, Vitest } from 'vitest/node'

// How many of the slowest test files the closing summary names.
export const SLOWEST_FILE_COUNT = 10

// Vitest picks its `minimal` reporter on its own when it detects a coding agent from the
// environment (CLAUDECODE, CODEX_THREAD_ID and the like), and that reporter prints no
// line for a file that passed. The merge gate and every worktree agent run the suite in
// such an environment, so their logs carried a total and nothing else. Naming the
// default reporter keeps one line per file, with its project, test count and duration,
// in every run that is not attached to a terminal; GitHub Actions keeps the annotations
// it would have been given anyway. The duration summary closes every run.
export function testReporters(environment: NodeJS.ProcessEnv): (string | Reporter)[] {
  return [
    'default',
    ...environment.GITHUB_ACTIONS === 'true' ? ['github-actions'] : [],
    new DurationSummaryReporter(),
  ]
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`
}

// Ends a run with the files that took longest and the wall time of each project. The
// projects run one after the other, so a project's wall time runs from its first file
// being queued to its last file finishing.
export class DurationSummaryReporter implements Reporter {
  private vitest: Vitest | undefined
  private readonly projectStarts = new Map<string, number>()
  private readonly projectEnds = new Map<string, number>()

  onInit(vitest: Vitest): void {
    this.vitest = vitest
  }

  onTestRunStart(): void {
    this.projectStarts.clear()
    this.projectEnds.clear()
  }

  onTestModuleQueued(testModule: TestModule): void {
    const project = testModule.project.name
    if (!this.projectStarts.has(project)) this.projectStarts.set(project, performance.now())
  }

  onTestModuleEnd(testModule: TestModule): void {
    this.projectEnds.set(testModule.project.name, performance.now())
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    if (testModules.length === 0) return
    const files = testModules.map((testModule) => ({
      name: testModule.relativeModuleId,
      project: testModule.project.name,
      tests: [...testModule.children.allTests()].length,
      duration: testModule.diagnostic().duration,
    })).sort((left, right) => right.duration - left.duration)
    const projectWidth = Math.max(...files.map(({ project }) => project.length))
    const lines = [`Slowest ${Math.min(SLOWEST_FILE_COUNT, files.length)} test files:`]
    for (const file of files.slice(0, SLOWEST_FILE_COUNT)) {
      lines.push(`  ${seconds(file.duration).padStart(7)}  ${file.project.padEnd(projectWidth)}  ${file.name} (${file.tests} test${file.tests === 1 ? '' : 's'})`)
    }
    const groups = [...this.projectStarts].map(([project, startedAt]) => (
      `${project} ${seconds((this.projectEnds.get(project) ?? startedAt) - startedAt)}`
    ))
    lines.push(`Wall time by group: ${groups.join(', ')}`)
    for (const line of lines) this.vitest?.logger.log(line)
  }
}
