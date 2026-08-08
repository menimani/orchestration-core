import type { Forge, WorkflowRun } from './adapters/forge.ts'

export interface Deployment {
  workflow: string
  url: string
}

export interface DeploymentClock {
  now(): Date
  sleep(milliseconds: number): Promise<void>
}

export interface DeploymentResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
}

export type DeploymentFetcher = (url: string) => Promise<DeploymentResponse>

export interface DeploymentResult {
  run: WorkflowRun
  dispatchedAt: Date
  lastModified: Date | undefined
  verified: boolean
}

const systemClock: DeploymentClock = {
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

/**
 * Dispatch, identify, and verify one deployment. The dispatch timestamp is rounded
 * down to HTTP/GitHub's whole-second timestamp precision so a same-second deployment
 * is not rejected merely because its source omitted milliseconds.
 */
export async function deploy(
  deployment: Deployment,
  ref: string,
  forge: Forge,
  options: {
    fetcher?: DeploymentFetcher
    clock?: DeploymentClock
    pollMilliseconds?: number
  } = {},
): Promise<DeploymentResult> {
  const clock = options.clock ?? systemClock
  const fetcher = options.fetcher ?? fetch
  const pollMilliseconds = options.pollMilliseconds ?? 5_000
  const dispatchedAt = new Date(Math.floor(clock.now().getTime() / 1_000) * 1_000)

  await forge.dispatchWorkflow(deployment.workflow, ref)

  let run: WorkflowRun | undefined
  while (run === undefined) {
    run = await forge.findWorkflowRun(deployment.workflow, dispatchedAt)
    if (run === undefined) await clock.sleep(pollMilliseconds)
  }
  while (run.status !== 'completed') {
    await clock.sleep(pollMilliseconds)
    run = await forge.getWorkflowRun(run.id)
  }
  if (run.conclusion !== 'success') {
    throw new Error(`Deployment workflow run ${run.id} finished with conclusion '${run.conclusion ?? 'unknown'}'.`)
  }

  const response = await fetcher(deployment.url)
  if (!response.ok) {
    throw new Error(`Deployment verification request failed with HTTP ${response.status}.`)
  }
  const rawLastModified = response.headers.get('last-modified')
  const lastModified = rawLastModified === null ? undefined : new Date(rawLastModified)
  const validLastModified = lastModified !== undefined && !Number.isNaN(lastModified.getTime())
    ? lastModified
    : undefined

  return {
    run,
    dispatchedAt,
    lastModified: validLastModified,
    verified: validLastModified !== undefined && validLastModified.getTime() >= dispatchedAt.getTime(),
  }
}
