import { describe, expect, it, vi } from 'vitest'
import { deploy, type DeploymentClock } from '../src/deploy.ts'
import { makeFakeForge } from './fakeForge.ts'

function response(revision: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => revision,
  }
}

function clock(): DeploymentClock {
  return { sleep: vi.fn(async () => {}) }
}

describe('deploy', () => {
  it('correlates its token, polls only that run id, and verifies its exact commit', async () => {
    const forge = makeFakeForge()
    const dispatchWorkflow = vi.fn(async () => {})
    const findWorkflowRun = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: 73,
        createdAt: '2026-08-08T15:00:01Z',
        headSha: '73aa',
        status: 'in_progress',
        conclusion: null,
      })
    const getWorkflowRun = vi.fn(async () => ({
      id: 73,
      createdAt: '2026-08-08T15:00:01Z',
      headSha: '73aa',
      status: 'completed',
      conclusion: 'success',
    }))
    Object.assign(forge, { dispatchWorkflow, findWorkflowRun, getWorkflowRun })
    const deploymentClock = clock()
    const fetcher = vi.fn(async () => response('73aa\n'))

    const result = await deploy(
      {
        workflow: 'deploy.yml',
        revisionUrl: 'https://shiora.jp/.well-known/shiora-revision',
      },
      'main',
      forge,
      {
        clock: deploymentClock,
        fetcher,
        pollMilliseconds: 1,
        createDispatchToken: () => 'dispatch-73',
      },
    )

    expect(dispatchWorkflow).toHaveBeenCalledWith('deploy.yml', 'main', 'dispatch-73')
    expect(findWorkflowRun).toHaveBeenLastCalledWith('deploy.yml', 'main', 'dispatch-73')
    expect(getWorkflowRun).toHaveBeenCalledWith(73)
    expect(fetcher).toHaveBeenCalledWith('https://shiora.jp/.well-known/shiora-revision')
    expect(result).toMatchObject({
      dispatchToken: 'dispatch-73',
      expectedRevision: '73aa',
      deployedRevision: '73aa',
      verified: true,
    })
    expect(deploymentClock.sleep).toHaveBeenCalledTimes(2)
  })

  it('rejects a healthy response from an unrelated deployment', async () => {
    const forge = makeFakeForge()
    forge.findWorkflowRun = async () => ({
      id: 74,
      createdAt: '2026-08-08T15:00:00Z',
      headSha: 'expected-sha',
      status: 'completed',
      conclusion: 'success',
    })

    const result = await deploy(
      {
        workflow: 'deploy.yml',
        revisionUrl: 'https://shiora.jp/.well-known/shiora-revision',
      },
      'main',
      forge,
      {
        clock: clock(),
        fetcher: async () => response('other-sha'),
        createDispatchToken: () => 'dispatch-74',
      },
    )

    expect(result.verified).toBe(false)
    expect(result.expectedRevision).toBe('expected-sha')
    expect(result.deployedRevision).toBe('other-sha')
  })

  it('fails the command when the revision endpoint is unavailable', async () => {
    const forge = makeFakeForge()
    forge.findWorkflowRun = async () => ({
      id: 75,
      createdAt: '2026-08-08T15:00:00Z',
      headSha: 'expected-sha',
      status: 'completed',
      conclusion: 'success',
    })

    await expect(deploy(
      {
        workflow: 'deploy.yml',
        revisionUrl: 'https://shiora.jp/.well-known/shiora-revision',
      },
      'main',
      forge,
      {
        clock: clock(),
        fetcher: async () => response('', 404),
        createDispatchToken: () => 'dispatch-75',
      },
    )).rejects.toThrow('Deployment verification request failed with HTTP 404.')
  })

  it('times out when the dispatched workflow never appears', async () => {
    const forge = makeFakeForge()
    forge.findWorkflowRun = vi.fn(async () => undefined)
    let time = 0
    const deploymentClock: DeploymentClock = {
      sleep: vi.fn(async (milliseconds) => { time += milliseconds }),
    }

    await expect(deploy(
      {
        workflow: 'deploy.yml',
        revisionUrl: 'https://shiora.jp/.well-known/shiora-revision',
      },
      'main',
      forge,
      {
        clock: deploymentClock,
        now: () => time,
        pollMilliseconds: 4_000,
        discoveryTimeoutMilliseconds: 10_000,
        createDispatchToken: () => 'missing-dispatch',
      },
    )).rejects.toThrow(
      "Timed out after 10000ms waiting for dispatched deployment workflow 'deploy.yml' (token 'missing-dispatch') to appear.",
    )
    expect(deploymentClock.sleep).toHaveBeenCalledTimes(3)
    expect(deploymentClock.sleep).toHaveBeenLastCalledWith(2_000)
    expect(forge.findWorkflowRun).toHaveBeenCalledTimes(4)
  })

  it('times out when the discovered workflow never completes', async () => {
    const forge = makeFakeForge()
    forge.findWorkflowRun = async () => ({
      id: 76,
      createdAt: '2026-08-08T15:00:00Z',
      headSha: 'expected-sha',
      status: 'in_progress',
      conclusion: null,
    })
    forge.getWorkflowRun = vi.fn(async () => ({
      id: 76,
      createdAt: '2026-08-08T15:00:00Z',
      headSha: 'expected-sha',
      status: 'in_progress',
      conclusion: null,
    }))
    let time = 0
    const deploymentClock: DeploymentClock = {
      sleep: vi.fn(async (milliseconds) => { time += milliseconds }),
    }

    await expect(deploy(
      {
        workflow: 'deploy.yml',
        revisionUrl: 'https://shiora.jp/.well-known/shiora-revision',
      },
      'main',
      forge,
      {
        clock: deploymentClock,
        now: () => time,
        pollMilliseconds: 4_000,
        completionTimeoutMilliseconds: 9_000,
        createDispatchToken: () => 'unfinished-dispatch',
      },
    )).rejects.toThrow(
      'Timed out after 9000ms waiting for deployment workflow run 76 to complete.',
    )
    expect(deploymentClock.sleep).toHaveBeenCalledTimes(3)
    expect(deploymentClock.sleep).toHaveBeenLastCalledWith(1_000)
    expect(forge.getWorkflowRun).toHaveBeenCalledTimes(3)
  })
})
