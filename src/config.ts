import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReasoningEffort } from './adapters/runner.ts'
import { PACKAGE_ROOT } from './paths.ts'

const MAX_POLL_INTERVAL_SECONDS = 30 * 60

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
  scanEffort: ReasoningEffort
  taskEffort: ReasoningEffort
  reviewEffort: ReasoningEffort
  scanModel: string
  taskModel: string
  scanParallel: number
  taskGate: 'full' | 'light'
  forge: string
  runner: string
  /** Findings become forge issues that workers claim, instead of direct local enqueues. */
  issueQueueEnabled: boolean
  /** Claim and execute shared work without scanning, reviewing, or merging it locally. */
  workerMode: boolean
  /** Hours an in-progress issue may sit unupdated before its lease is reaped. */
  issueLeaseHours: number
  /** Pull the consumed orchestration subtree at the safe pre-cycle boundary. */
  coreAutoUpdate: boolean
  /** Git remote, URL, or owner/repository shorthand for the shared core. */
  upstreamRemote: string
  /** Branch fetched and pulled into the shared-core subtree. */
  upstreamBranch: string
}

interface PackageMetadata {
  upstreamRepo?: unknown
}

function defaultUpstreamRemote(): string {
  const metadata = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as PackageMetadata
  return typeof metadata.upstreamRepo === 'string' && metadata.upstreamRepo.trim() !== ''
    ? metadata.upstreamRepo.trim()
    : ''
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
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be 'true' or 'false', got '${raw}'`)
}

function str(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

function effort(env: NodeJS.ProcessEnv, name: string, fallback: ReasoningEffort): ReasoningEffort {
  const value = str(env, name, fallback)
  if (!['minimal', 'low', 'medium', 'high'].includes(value)) {
    throw new Error(`${name} must be minimal, low, medium or high, got '${value}'`)
  }
  return value as ReasoningEffort
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoopConfig {
  const maxParallel = num(env, 'MAX_PARALLEL', 3)
  if (maxParallel < 1) {
    throw new Error('MAX_PARALLEL must be at least 1')
  }
  const taskGate = str(env, 'TASK_GATE', 'full')
  if (taskGate !== 'full' && taskGate !== 'light') {
    throw new Error(`TASK_GATE must be 'full' or 'light', got '${taskGate}'`)
  }
  // SCAN_PARALLEL: the loop supports up to four concurrent scans, so higher values clamp.
  const scanParallel = Math.min(num(env, 'SCAN_PARALLEL', 2), 4)
  if (scanParallel < 1) {
    throw new Error('SCAN_PARALLEL must be at least 1')
  }
  const issueQueueEnabled = bool(env, 'ISSUE_QUEUE_ENABLED', false)
  const workerMode = bool(env, 'WORKER_MODE', false)
  if (workerMode && !issueQueueEnabled) {
    throw new Error('WORKER_MODE requires ISSUE_QUEUE_ENABLED=true')
  }
  const pollIntervalSeconds = num(env, 'POLL_INTERVAL', 30)
  if (pollIntervalSeconds > MAX_POLL_INTERVAL_SECONDS) {
    throw new Error(`POLL_INTERVAL must not exceed ${MAX_POLL_INTERVAL_SECONDS} seconds`)
  }
  return {
    maxParallel,
    pollIntervalSeconds,
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
    scanEffort: effort(env, 'SCAN_EFFORT', 'high'),
    taskEffort: effort(env, 'TASK_EFFORT', 'medium'),
    reviewEffort: effort(env, 'REVIEW_EFFORT', 'high'),
    scanModel: str(env, 'SCAN_MODEL', ''),
    taskModel: str(env, 'TASK_MODEL', ''),
    scanParallel,
    taskGate,
    forge: str(env, 'FORGE', 'github'),
    runner: str(env, 'RUNNER', 'codex'),
    issueQueueEnabled,
    workerMode,
    issueLeaseHours: num(env, 'ISSUE_LEASE_HOURS', 3),
    coreAutoUpdate: bool(env, 'CORE_AUTO_UPDATE', true),
    upstreamRemote: str(env, 'UPSTREAM_REMOTE', defaultUpstreamRemote()),
    upstreamBranch: str(env, 'UPSTREAM_BRANCH', 'main'),
  }
}
