import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('returns the bash defaults for an empty environment', () => {
    const config = loadConfig({})
    expect(config).toMatchObject({
      maxParallel: 3,
      pollIntervalSeconds: 30,
      autoMerge: true,
      maxGrowthDepth: 2,
      maxTotalTasks: 50,
      scanEnabled: true,
      maxScanCycles: 3,
      maxCiFixAttempts: 2,
      maxEmptyScans: 2,
      autoPr: true,
      reviewEnabled: true,
      ciGateEnabled: false,
      autoReview: false,
      maxReviewRounds: 2,
      reviewEveryNCycles: 1,
      maxFinalReviewRounds: 4,
      maxBurstFailures: 3,
      maxConsecutiveMergeFailures: 3,
      scanEffort: 'high',
      taskEffort: 'medium',
      reviewEffort: 'high',
      scanParallel: 2,
      taskGate: 'full',
      forge: 'github',
      runner: 'codex',
      project: '',
      workerMode: false,
      coreAutoUpdate: true,
      upstreamRemote: 'menimani/orchestration-core',
      upstreamBranch: 'main',
    })
  })

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      MAX_PARALLEL: '12',
      REVIEW_EVERY_N_CYCLES: '3',
      TASK_GATE: 'light',
      AUTO_REVIEW: 'true',
      REVIEW_EFFORT: 'low',
      TASK_EFFORT: 'high',
      TASK_MODEL: 'task-model',
      CORE_AUTO_UPDATE: 'false',
      UPSTREAM_REMOTE: 'shared-core',
      UPSTREAM_BRANCH: 'stable',
    })
    expect(config.maxParallel).toBe(12)
    expect(config.reviewEveryNCycles).toBe(3)
    expect(config.taskGate).toBe('light')
    expect(config.autoReview).toBe(true)
    expect(config.reviewEffort).toBe('low')
    expect(config.taskEffort).toBe('high')
    expect(config.taskModel).toBe('task-model')
    expect(config.coreAutoUpdate).toBe(false)
    expect(config.upstreamRemote).toBe('shared-core')
    expect(config.upstreamBranch).toBe('stable')
  })

  it('clamps SCAN_PARALLEL to the four defined checklist groups', () => {
    expect(loadConfig({ SCAN_PARALLEL: '9' }).scanParallel).toBe(4)
  })

  it('rejects a TASK_GATE value that is neither full nor light', () => {
    expect(() => loadConfig({ TASK_GATE: 'fast' })).toThrow(/TASK_GATE/)
  })

  it('rejects an unsupported reasoning effort', () => {
    expect(() => loadConfig({ REVIEW_EFFORT: 'maximum' })).toThrow(/REVIEW_EFFORT/)
  })

  it('rejects a non-integer numeric setting', () => {
    expect(() => loadConfig({ MAX_PARALLEL: 'many' })).toThrow(/MAX_PARALLEL/)
  })

  it('rejects MAX_PARALLEL below one', () => {
    expect(() => loadConfig({ MAX_PARALLEL: '0' })).toThrow(/MAX_PARALLEL must be at least 1/)
  })

  it('rejects a poll interval longer than the issue heartbeat interval', () => {
    expect(loadConfig({ POLL_INTERVAL: '1800' }).pollIntervalSeconds).toBe(1800)
    expect(() => loadConfig({ POLL_INTERVAL: '1801' })).toThrow(
      /POLL_INTERVAL must not exceed 1800 seconds/,
    )
  })

  it('enables worker mode only with the issue queue', () => {
    expect(loadConfig({ ISSUE_QUEUE_ENABLED: 'true', WORKER_MODE: 'true' }).workerMode).toBe(true)
    expect(() => loadConfig({ WORKER_MODE: 'true' })).toThrow(/requires ISSUE_QUEUE_ENABLED=true/)
  })
})
