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
      runnerClaudeModel: 'claude-opus-5',
      runnerClaudeModelMinimal: 'claude-opus-5',
      runnerClaudeModelLow: 'claude-opus-5',
      runnerClaudeModelMedium: 'claude-opus-5',
      runnerClaudeModelHigh: 'claude-opus-5',
      workerMode: false,
      coreAutoUpdate: true,
      upstreamRemote: 'menimani/orchestration-core',
      upstreamBranch: 'main',
      integrationBranch: '',
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
      RUNNER_CLAUDE_MODEL: 'claude-base',
      RUNNER_CLAUDE_MODEL_MINIMAL: 'claude-small',
      RUNNER_CLAUDE_MODEL_HIGH: 'claude-large',
      CORE_AUTO_UPDATE: 'false',
      UPSTREAM_REMOTE: 'shared-core',
      UPSTREAM_BRANCH: 'stable',
      INTEGRATION_BRANCH: 'integration/run',
    })
    expect(config.maxParallel).toBe(12)
    expect(config.reviewEveryNCycles).toBe(3)
    expect(config.taskGate).toBe('light')
    expect(config.autoReview).toBe(true)
    expect(config.reviewEffort).toBe('low')
    expect(config.taskEffort).toBe('high')
    expect(config.taskModel).toBe('task-model')
    expect(config.runnerClaudeModel).toBe('claude-base')
    expect(config.runnerClaudeModelMinimal).toBe('claude-small')
    expect(config.runnerClaudeModelLow).toBe('claude-base')
    expect(config.runnerClaudeModelMedium).toBe('claude-base')
    expect(config.runnerClaudeModelHigh).toBe('claude-large')
    expect(config.coreAutoUpdate).toBe(false)
    expect(config.upstreamRemote).toBe('shared-core')
    expect(config.upstreamBranch).toBe('stable')
    expect(config.integrationBranch).toBe('integration/run')
  })

  it.each([
    'ISSUE_QUEUE_ENABLED',
    'WORKER_MODE',
    'AUTO_MERGE',
    'SKIP_AUTO_TEST',
    'SCAN_ENABLED',
    'AUTO_PR',
    'REVIEW_ENABLED',
    'CI_GATE_ENABLED',
    'AUTO_REVIEW',
    'CORE_AUTO_UPDATE',
  ])('rejects an invalid %s boolean value', (name) => {
    expect(() => loadConfig({ [name]: 'tru' })).toThrow(
      `${name} must be 'true' or 'false', got 'tru'`,
    )
  })

  it('clamps SCAN_PARALLEL to four concurrent scans', () => {
    expect(loadConfig({ SCAN_PARALLEL: '9' }).scanParallel).toBe(4)
  })

  it('rejects SCAN_PARALLEL below one', () => {
    expect(loadConfig({ SCAN_PARALLEL: '1' }).scanParallel).toBe(1)
    expect(() => loadConfig({ SCAN_PARALLEL: '0' })).toThrow(
      /SCAN_PARALLEL must be at least 1/,
    )
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

  it('rejects REVIEW_EVERY_N_CYCLES below one', () => {
    expect(loadConfig({ REVIEW_EVERY_N_CYCLES: '1' }).reviewEveryNCycles).toBe(1)
    expect(() => loadConfig({ REVIEW_EVERY_N_CYCLES: '0' })).toThrow(
      /REVIEW_EVERY_N_CYCLES must be at least 1/,
    )
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
