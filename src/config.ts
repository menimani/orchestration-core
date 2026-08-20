import { readFileSync, statSync } from 'node:fs'
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
  maxIssueRetries: number
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
  /** Optional merge and promotion branch kept in a separate worktree. */
  integrationBranch: string
}

export type ConfigName = typeof CONFIG_ENV_NAMES[keyof LoopConfig]
export type ConfigValue = LoopConfig[keyof LoopConfig]

export interface ConfigEvent {
  type: 'changed' | 'ignored' | 'error'
  message: string
  setting?: ConfigName
  previous?: ConfigValue
  value?: ConfigValue
}

export interface LoadConfigOptions {
  /** Set false when resolving contract defaults without any repository file. */
  filePath?: string | false
  onEvent?: (event: ConfigEvent) => void
}

export const CONFIG_ENV_NAMES: Readonly<Record<keyof LoopConfig, string>> = {
  maxParallel: 'MAX_PARALLEL',
  pollIntervalSeconds: 'POLL_INTERVAL',
  autoMerge: 'AUTO_MERGE',
  testCmd: 'TEST_CMD',
  skipAutoTest: 'SKIP_AUTO_TEST',
  maxGrowthDepth: 'MAX_GROWTH_DEPTH',
  maxTotalTasks: 'MAX_TOTAL_TASKS',
  scanEnabled: 'SCAN_ENABLED',
  maxScanCycles: 'MAX_SCAN_CYCLES',
  maxCiFixAttempts: 'MAX_CI_FIX_ATTEMPTS',
  maxEmptyScans: 'MAX_EMPTY_SCANS',
  autoPr: 'AUTO_PR',
  reviewEnabled: 'REVIEW_ENABLED',
  ciGateEnabled: 'CI_GATE_ENABLED',
  autoReview: 'AUTO_REVIEW',
  maxReviewRounds: 'MAX_REVIEW_ROUNDS',
  reviewEveryNCycles: 'REVIEW_EVERY_N_CYCLES',
  maxFinalReviewRounds: 'MAX_FINAL_REVIEW_ROUNDS',
  maxBurstFailures: 'MAX_BURST_FAILURES',
  maxIssueRetries: 'MAX_ISSUE_RETRIES',
  maxConsecutiveMergeFailures: 'MAX_CONSECUTIVE_MERGE_FAILURES',
  scanEffort: 'SCAN_EFFORT',
  taskEffort: 'TASK_EFFORT',
  reviewEffort: 'REVIEW_EFFORT',
  scanModel: 'SCAN_MODEL',
  taskModel: 'TASK_MODEL',
  scanParallel: 'SCAN_PARALLEL',
  taskGate: 'TASK_GATE',
  forge: 'FORGE',
  runner: 'RUNNER',
  issueQueueEnabled: 'ISSUE_QUEUE_ENABLED',
  workerMode: 'WORKER_MODE',
  issueLeaseHours: 'ISSUE_LEASE_HOURS',
  coreAutoUpdate: 'CORE_AUTO_UPDATE',
  upstreamRemote: 'UPSTREAM_REMOTE',
  upstreamBranch: 'UPSTREAM_BRANCH',
  integrationBranch: 'INTEGRATION_BRANCH',
}

const CONFIG_KEYS = Object.keys(CONFIG_ENV_NAMES) as (keyof LoopConfig)[]
const KEY_BY_NAME = new Map(CONFIG_KEYS.map((key) => [CONFIG_ENV_NAMES[key], key]))

export const PINNED_CONFIG_REASONS: Readonly<Partial<Record<keyof LoopConfig, string>>> = {
  forge: 'changing the forge would leave in-flight work owned by a component no longer in use',
  runner: 'changing the runner would leave in-flight work owned by a component no longer in use',
  issueQueueEnabled: 'changing queue mode would strand issues claimed under the old mode',
  workerMode: 'changing worker mode would strand issues claimed under the old mode',
  integrationBranch: 'changing the integration branch would split the run across branches',
  upstreamRemote: 'changing the upstream source would pull a different core into this run',
  upstreamBranch: 'changing the upstream source would pull a different core into this run',
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

function resolveConfig(env: NodeJS.ProcessEnv): LoopConfig {
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
  const reviewEveryNCycles = num(env, 'REVIEW_EVERY_N_CYCLES', 1)
  if (reviewEveryNCycles < 1) {
    throw new Error('REVIEW_EVERY_N_CYCLES must be at least 1')
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
    reviewEveryNCycles,
    maxFinalReviewRounds: num(env, 'MAX_FINAL_REVIEW_ROUNDS', 4),
    maxBurstFailures: num(env, 'MAX_BURST_FAILURES', 3),
    maxIssueRetries: num(env, 'MAX_ISSUE_RETRIES', 3),
    maxConsecutiveMergeFailures: num(env, 'MAX_CONSECUTIVE_MERGE_FAILURES', 3),
    scanEffort: effort(env, 'SCAN_EFFORT', 'medium'),
    taskEffort: effort(env, 'TASK_EFFORT', 'medium'),
    reviewEffort: effort(env, 'REVIEW_EFFORT', 'medium'),
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
    integrationBranch: str(env, 'INTEGRATION_BRANCH', ''),
  }
}

type ConfigFileValues = Record<string, unknown>

function fileValueText(name: string, value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  throw new Error(`${name} must be a JSON string, number or boolean`)
}

function environmentWithFile(
  env: NodeJS.ProcessEnv,
  values: ConfigFileValues,
): NodeJS.ProcessEnv {
  const resolved = { ...env }
  for (const [name, value] of Object.entries(values)) {
    if (!KEY_BY_NAME.has(name)) throw new Error(`Unknown configuration setting '${name}'`)
    resolved[name] = fileValueText(name, value)
  }
  return resolved
}

export function validateConfigFileValues(
  values: ConfigFileValues,
  env: NodeJS.ProcessEnv = process.env,
): LoopConfig {
  return resolveConfig(environmentWithFile(env, values))
}

export function defaultConfigFilePath(cwd = process.cwd()): string {
  return join(cwd, 'orchestration', 'config.json')
}

function parseConfigFile(text: string): ConfigFileValues {
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('configuration file must contain a JSON object')
  }
  return parsed as ConfigFileValues
}

function changedNames(previous: ConfigFileValues, next: ConfigFileValues): Set<string> {
  const names = new Set([...Object.keys(previous), ...Object.keys(next)])
  return new Set([...names].filter((name) => !Object.is(previous[name], next[name])))
}

function settingFromError(error: unknown, changed: Set<string>): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const mentioned = [...KEY_BY_NAME.keys()].filter((name) => message.includes(name))
  const unknown = message.match(/Unknown configuration setting '([^']+)'/)
  return mentioned.find((name) => changed.has(name)) ?? mentioned[0] ?? unknown?.[1]
}

/**
 * Return a run-long configuration resolver. The file parse is cached by mtime; the
 * proxy makes live settings resolve at their point of use without creating a second
 * override layer for consumers to understand.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): LoopConfig {
  const filePath = options.filePath === false
    ? undefined
    : options.filePath ?? defaultConfigFilePath()
  const report = options.onEvent ?? ((event: ConfigEvent) => console.error(event.message))
  const environmentConfig = resolveConfig(env)
  let activeValues: ConfigFileValues = {}
  let activeConfig = environmentConfig
  let observedStamp: string | undefined
  let refreshError: Error | undefined

  const emitError = (message: string, setting?: string): void => report({
    type: 'error',
    message,
    setting: setting !== undefined && KEY_BY_NAME.has(setting) ? setting as ConfigName : undefined,
  })

  const acceptValues = (parsed: ConfigFileValues): void => {
    activeConfig = validateConfigFileValues(parsed, env)
    activeValues = { ...parsed }
  }

  const refresh = (): void => {
    if (filePath === undefined) {
      if (observedStamp === undefined) {
        observedStamp = 'disabled'
        acceptValues({})
      }
      return
    }
    let stamp = 'missing'
    try {
      const stat = statSync(filePath)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error)
        if (observedStamp !== `error:${message}`) {
          observedStamp = `error:${message}`
          emitError(`Could not inspect ${filePath}: ${message}`)
        }
        return
      }
    }
    if (stamp === observedStamp) {
      if (refreshError !== undefined) throw refreshError
      return
    }
    observedStamp = stamp
    if (stamp === 'missing') {
      acceptValues({})
      refreshError = undefined
      return
    }
    let parsed: ConfigFileValues
    try {
      parsed = parseConfigFile(readFileSync(filePath, 'utf8'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      refreshError = new Error(
        `Invalid configuration file ${filePath} (setting: file contents): ${message}`,
      )
      emitError(refreshError.message)
      throw refreshError
    }
    try {
      acceptValues(parsed)
      refreshError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const setting = settingFromError(error, changedNames(activeValues, parsed))
      refreshError = new Error(
        `Invalid configuration file ${filePath} (setting: ${setting ?? 'unknown'}): ${message}`,
      )
      emitError(refreshError.message, setting)
      throw refreshError
    }
  }

  refresh()
  const pinned = Object.fromEntries(
    Object.keys(PINNED_CONFIG_REASONS).map((key) => [key, activeConfig[key as keyof LoopConfig]]),
  ) as Partial<LoopConfig>
  const lastUsed = new Map<keyof LoopConfig, ConfigValue>()
  const lastIgnored = new Map<keyof LoopConfig, ConfigValue>()
  const target = { ...activeConfig }

  return new Proxy(target, {
    get(_target, property, receiver) {
      if (typeof property !== 'string' || !(property in CONFIG_ENV_NAMES)) {
        return Reflect.get(target, property, receiver)
      }
      refresh()
      const key = property as keyof LoopConfig
      const name = CONFIG_ENV_NAMES[key] as ConfigName
      const proposed = activeConfig[key]
      const reason = PINNED_CONFIG_REASONS[key]
      if (reason !== undefined) {
        const value = pinned[key] as ConfigValue
        if (Object.is(proposed, value)) lastIgnored.delete(key)
        if (!Object.is(proposed, value) && !Object.is(lastIgnored.get(key), proposed)) {
          report({
            type: 'ignored', setting: name, previous: value, value: proposed,
            message: `Ignored ${name} change from '${String(value)}' to '${String(proposed)}': ${reason}`,
          })
          lastIgnored.set(key, proposed)
        }
        return value
      }
      const previous = lastUsed.get(key)
      lastUsed.set(key, proposed)
      if (previous !== undefined && !Object.is(previous, proposed)) {
        report({
          type: 'changed', setting: name, previous, value: proposed,
          message: `${name} changed from '${String(previous)}' to '${String(proposed)}'`,
        })
      }
      return proposed
    },
    set() {
      return false
    },
  })
}
