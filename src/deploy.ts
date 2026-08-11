import { randomUUID } from 'node:crypto'
import type { Forge, WorkflowRun } from './adapters/forge.ts'

export interface Deployment {
  workflow: string
  revisionUrl: string
}

export interface DeploymentClock {
  sleep(milliseconds: number): Promise<void>
}

export interface DeploymentResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type DeploymentFetcher = (url: string) => Promise<DeploymentResponse>

export interface DeploymentResult {
  run: WorkflowRun
  dispatchToken: string
  expectedRevision: string
  deployedRevision: string
  verified: boolean
}

const systemClock: DeploymentClock = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5 * 60_000
const DEFAULT_COMPLETION_TIMEOUT_MS = 30 * 60_000

/** Dispatch, identify, and verify one deployment by identities unique to this request. */
export async function deploy(
  deployment: Deployment,
  ref: string,
  forge: Forge,
  options: {
    fetcher?: DeploymentFetcher
    clock?: DeploymentClock
    pollMilliseconds?: number
    discoveryTimeoutMilliseconds?: number
    completionTimeoutMilliseconds?: number
    now?: () => number
    createDispatchToken?: () => string
  } = {},
): Promise<DeploymentResult> {
  const clock = options.clock ?? systemClock
  const fetcher = options.fetcher ?? fetch
  const pollMilliseconds = options.pollMilliseconds ?? 5_000
  const discoveryTimeoutMilliseconds = options.discoveryTimeoutMilliseconds
    ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  const completionTimeoutMilliseconds = options.completionTimeoutMilliseconds
    ?? DEFAULT_COMPLETION_TIMEOUT_MS
  const now = options.now ?? Date.now
  const dispatchToken = (options.createDispatchToken ?? randomUUID)()

  await forge.dispatchWorkflow(deployment.workflow, ref, dispatchToken)

  const discoveryDeadline = now() + discoveryTimeoutMilliseconds
  let run: WorkflowRun | undefined
  while (run === undefined) {
    run = await forge.findWorkflowRun(deployment.workflow, ref, dispatchToken)
    if (run === undefined) {
      const remaining = discoveryDeadline - now()
      if (remaining <= 0) {
        throw new Error(
          `Timed out after ${discoveryTimeoutMilliseconds}ms waiting for dispatched deployment workflow '${deployment.workflow}' (token '${dispatchToken}') to appear.`,
        )
      }
      await clock.sleep(Math.min(pollMilliseconds, remaining))
    }
  }

  const completionDeadline = now() + completionTimeoutMilliseconds
  while (run.status !== 'completed') {
    const remaining = completionDeadline - now()
    if (remaining <= 0) {
      throw new Error(
        `Timed out after ${completionTimeoutMilliseconds}ms waiting for deployment workflow run ${run.id} to complete.`,
      )
    }
    await clock.sleep(Math.min(pollMilliseconds, remaining))
    run = await forge.getWorkflowRun(run.id)
  }
  if (run.conclusion !== 'success') {
    throw new Error(`Deployment workflow run ${run.id} finished with conclusion '${run.conclusion ?? 'unknown'}'.`)
  }

  const response = await fetcher(deployment.revisionUrl)
  if (!response.ok) {
    throw new Error(`Deployment verification request failed with HTTP ${response.status}.`)
  }
  const deployedRevision = (await response.text()).trim()

  return {
    run,
    dispatchToken,
    expectedRevision: run.headSha,
    deployedRevision,
    verified: deployedRevision === run.headSha,
  }
}
