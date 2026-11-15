// The fixture helpers the merge gate handback test files share: a scripted merge gate,
// a controlled runner process, and a claimed task handed back after two failures.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { Runner } from '../src/adapters/runner.ts'
import type { LoopConfig } from '../src/config.ts'
import { gateFixSpecFile, readGateFixState } from '../src/gateFix.ts'
import {
  issueFailureCount, issueNumbersForTask, recordIssuesForTask, LABEL_FINDING, LABEL_IN_PROGRESS,
  LABEL_READY,
} from '../src/issueQueue.ts'
import { branchName, finalMessageFile, worktreeDir } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import {
  fakeForge, git, initializeGitRepo, logged, logText, makeCompletedTask, makeLoop, makeRunner,
  paths, runnerStarts, stubProject, writeFinal, writeRawStatus,
} from './loopHarness.ts'

export const REQUIREMENT = 'Add the widget counter and cover it with a test.'
export const FAILURE_OUTPUT = 'expected 3 but got 4'

export const gateConfig: Partial<LoopConfig> = {
  autoMerge: true,
  issueQueueEnabled: false,
  scanEnabled: false,
  reviewEnabled: false,
  autoPr: false,
  maxParallel: 1,
  maxConsecutiveMergeFailures: 3,
  maxGateFixAttempts: 1,
  taskGate: 'full',
}

/** A project whose merge gate fails or passes per run, in the order given; the last repeats. */
export function scriptedGate(outcomes: ('fail' | 'pass')[], output = FAILURE_OUTPUT): ProjectAdapter {
  let run = 0
  return {
    ...stubProject,
    mergeChecks: () => {
      const outcome = outcomes[Math.min(run, outcomes.length - 1)]
      run += 1
      return [{
        label: 'Verification', cwd: '',
        command: outcome === 'fail'
          ? `node -e "console.log('${output}'); process.exit(1)"`
          : 'node -e ""',
      }]
    },
  }
}

export function makeTask(taskId: string): void {
  makeCompletedTask(taskId)
  writeFileSync(join(paths.tasksDir, `${taskId}.md`), `# spec\n\n## Requirement\n\n${REQUIREMENT}\n`)
}

/** What a handed-back runner leaves when it finishes: the marker, and no live process. */
export function finishHandback(taskId: string): void {
  writeFinal(taskId, 'TASK_COMPLETE\n')
  writeRawStatus(taskId, 'completed')
}

export function failureCount(): string {
  return readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')
}

export function handbacks(): string[] {
  return logged.filter((line) => line.startsWith('Handback '))
}

/**
 * A runner PID no process owns, answered as a live process with a stable start identity
 * until \`end\` is called or its tree is terminated, so a test decides when the run ends.
 */
export function controlledProcess(): { pid: number; end: () => void; runner: Runner } {
  const pid = process.pid + 1_000_000
  let alive = true
  const { processStartIdentity, processIsAlive, processTreeIsAlive, terminateProcessTree } =
    operatingSystem
  vi.spyOn(operatingSystem, 'processStartIdentity').mockImplementation((probed) =>
    (probed === pid ? 'controlled-start' : processStartIdentity(probed)))
  vi.spyOn(operatingSystem, 'processIsAlive').mockImplementation((probed) =>
    (probed === pid ? alive : processIsAlive(probed)))
  vi.spyOn(operatingSystem, 'processTreeIsAlive').mockImplementation((probed) =>
    (probed === pid ? alive : processTreeIsAlive(probed)))
  vi.spyOn(operatingSystem, 'terminateProcessTree').mockImplementation((probed) => {
    if (probed !== pid) return terminateProcessTree(probed)
    alive = false
    return true
  })
  return {
    pid,
    end: () => { alive = false },
    runner: {
      ...makeRunner(),
      start: async (options) => {
        runnerStarts.push(options.specFile)
        return pid
      },
    },
  }
}

export const issueGateConfig: Partial<LoopConfig> = { ...gateConfig, issueQueueEnabled: true }

/** A task with a claimed issue, handed back after two verification failures. */
export async function handBackClaimedTask(
  taskId: string,
  runner: Runner,
  config: Partial<LoopConfig> = {},
  clock?: () => Date,
): Promise<{ loop: ReturnType<typeof makeLoop>; issueNumber: number; tip: string }> {
  initializeGitRepo()
  makeTask(taskId)
  const tip = git(['rev-parse', branchName(taskId)]).trim()
  const loop = makeLoop({ ...issueGateConfig, ...config }, scriptedGate(['fail']), undefined,
    clock, runner)
  loop.initializeSessionStateForBranch()
  const issueNumber = await fakeForge.createIssue({
    title: 'handed back fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    assignees: [fakeForge.user],
  })
  recordIssuesForTask(paths, taskId, [issueNumber])

  await loop.poll()
  await loop.poll()
  expect(runnerStarts).toEqual([gateFixSpecFile(paths, taskId)])
  return { loop, issueNumber, tip }
}

/** The task as the handback found it: completed, its commits and claim intact, the attempt used. */
export async function expectReturnedToCompleted(
  taskId: string,
  tip: string,
  issueNumber: number,
): Promise<void> {
  expect(readStatus(paths, taskId)?.status).toBe('completed')
  expect(git(['rev-parse', branchName(taskId)]).trim()).toBe(tip)
  expect(existsSync(worktreeDir(paths, taskId))).toBe(true)
  expect(readFileSync(finalMessageFile(paths, taskId), 'utf8')).toBe('TASK_COMPLETE\n')
  expect(readGateFixState(paths, taskId)?.attempts).toBe(1)
  expect(readGateFixState(paths, taskId)?.pending).toBe(false)
  expect(issueNumbersForTask(paths, taskId)).toEqual([issueNumber])
  expect(issueFailureCount(paths, issueNumber)).toBe(0)
  const issue = await fakeForge.getIssue(issueNumber)
  expect(issue.state).toBe('open')
  expect(issue.labels).toContain(LABEL_IN_PROGRESS)
  expect(issue.labels).not.toContain(LABEL_READY)
  expect(logged.some((line) => line.startsWith(`FAILED: ${taskId}`))).toBe(false)
  expect(logText()).not.toContain('Released')
}
