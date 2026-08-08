// Every setting the loop honors, with the defaults the bash implementation shipped.
// The environment variable names are part of the frozen CLI contract (SPEC.md,
// "Runtime"): launch commands and the loop-start skill keep working unchanged.

export interface LoopConfig {
  maxParallel: number
  pollIntervalSeconds: number
  autoMerge: boolean
  testCmd: string
  skipAutoTest: boolean
  maxGrowthDepth: number
  maxTotalTasks: number
  scanEnabled: boolean
  maxScanCycles: number
  maxCiFixAttempts: number
  maxEmptyScans: number
  autoPr: boolean
  reviewEnabled: boolean
  ciGateEnabled: boolean
  autoReview: boolean
  maxReviewRounds: number
  reviewEveryNCycles: number
  maxFinalReviewRounds: number
  maxBurstFailures: number
  maxConsecutiveMergeFailures: number
  scanEffort: string
  taskEffort: string
  scanModel: string
  taskModel: string
  scanParallel: number
  taskGate: 'full' | 'light'
  forge: string
  runner: string
  project: string
  /** Findings become forge issues that workers claim, instead of direct local enqueues. */
  issueQueueEnabled: boolean
  /** Hours an in-progress issue may sit unupdated before its lease is reaped. */
  issueLeaseHours: number
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'`)
  }
  return value
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === 'true'
}

function str(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoopConfig {
  const taskGate = str(env, 'TASK_GATE', 'full')
  if (taskGate !== 'full' && taskGate !== 'light') {
    throw new Error(`TASK_GATE must be 'full' or 'light', got '${taskGate}'`)
  }
  // SCAN_PARALLEL: checklist groups are defined up to 4, so higher values clamp.
  const scanParallel = Math.min(num(env, 'SCAN_PARALLEL', 2), 4)
  return {
    maxParallel: num(env, 'MAX_PARALLEL', 3),
    pollIntervalSeconds: num(env, 'POLL_INTERVAL', 30),
    autoMerge: bool(env, 'AUTO_MERGE', true),
    testCmd: str(env, 'TEST_CMD', ''),
    skipAutoTest: bool(env, 'SKIP_AUTO_TEST', false),
    maxGrowthDepth: num(env, 'MAX_GROWTH_DEPTH', 2),
    maxTotalTasks: num(env, 'MAX_TOTAL_TASKS', 50),
    scanEnabled: bool(env, 'SCAN_ENABLED', true),
    maxScanCycles: num(env, 'MAX_SCAN_CYCLES', 3),
    maxCiFixAttempts: num(env, 'MAX_CI_FIX_ATTEMPTS', 2),
    maxEmptyScans: num(env, 'MAX_EMPTY_SCANS', 2),
    autoPr: bool(env, 'AUTO_PR', true),
    reviewEnabled: bool(env, 'REVIEW_ENABLED', true),
    ciGateEnabled: bool(env, 'CI_GATE_ENABLED', false),
    autoReview: bool(env, 'AUTO_REVIEW', false),
    maxReviewRounds: num(env, 'MAX_REVIEW_ROUNDS', 2),
    reviewEveryNCycles: num(env, 'REVIEW_EVERY_N_CYCLES', 1),
    maxFinalReviewRounds: num(env, 'MAX_FINAL_REVIEW_ROUNDS', 4),
    maxBurstFailures: num(env, 'MAX_BURST_FAILURES', 3),
    maxConsecutiveMergeFailures: num(env, 'MAX_CONSECUTIVE_MERGE_FAILURES', 3),
    scanEffort: str(env, 'SCAN_EFFORT', 'high'),
    taskEffort: str(env, 'TASK_EFFORT', 'medium'),
    scanModel: str(env, 'SCAN_MODEL', ''),
    taskModel: str(env, 'TASK_MODEL', ''),
    scanParallel,
    taskGate,
    forge: str(env, 'FORGE', 'github'),
    runner: str(env, 'RUNNER', 'codex'),
    project: str(env, 'PROJECT', 'shiora'),
    issueQueueEnabled: bool(env, 'ISSUE_QUEUE_ENABLED', false),
    issueLeaseHours: num(env, 'ISSUE_LEASE_HOURS', 3),
  }
}
