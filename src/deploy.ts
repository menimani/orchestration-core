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

/** Dispatch, identify, and verify one deployment by identities unique to this request. */
export async function deploy(
  deployment: Deployment,
  ref: string,
  forge: Forge,
  options: {
    fetcher?: DeploymentFetcher
    clock?: DeploymentClock
    pollMilliseconds?: number
    createDispatchToken?: () => string
  } = {},
): Promise<DeploymentResult> {
  const clock = options.clock ?? systemClock
  const fetcher = options.fetcher ?? fetch
  const pollMilliseconds = options.pollMilliseconds ?? 5_000
  const dispatchToken = (options.createDispatchToken ?? randomUUID)()

  await forge.dispatchWorkflow(deployment.workflow, ref, dispatchToken)

  let run: WorkflowRun | undefined
  while (run === undefined) {
    run = await forge.findWorkflowRun(deployment.workflow, ref, dispatchToken)
    if (run === undefined) await clock.sleep(pollMilliseconds)
  }
  while (run.status !== 'completed') {
    await clock.sleep(pollMilliseconds)
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
