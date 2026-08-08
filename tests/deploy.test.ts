import { describe, expect, it, vi } from 'vitest'
import { deploy, type DeploymentClock } from '../src/deploy.ts'
import { makeFakeForge } from './fakeForge.ts'

function response(lastModified: string | null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => name === 'last-modified' ? lastModified : null },
  }
}

function clock(now: string): DeploymentClock {
  return {
    now: () => new Date(now),
    sleep: vi.fn(async () => {}),
  }
}

describe('deploy', () => {
  it('waits for its new run, polls that run id, and passes fresh content', async () => {
    const forge = makeFakeForge()
    const dispatchWorkflow = vi.fn(async () => {})
    const findWorkflowRun = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: 73, createdAt: '2026-08-08T15:00:01Z', status: 'in_progress', conclusion: null,
      })
    const getWorkflowRun = vi.fn(async () => ({
      id: 73, createdAt: '2026-08-08T15:00:01Z', status: 'completed', conclusion: 'success',
    }))
    Object.assign(forge, { dispatchWorkflow, findWorkflowRun, getWorkflowRun })
    const deploymentClock = clock('2026-08-08T15:00:00.987Z')
    const fetcher = vi.fn(async () => response('Sat, 08 Aug 2026 15:00:02 GMT'))

    const result = await deploy(
      { workflow: 'deploy.yml', url: 'https://shiora.jp' }, 'main', forge,
      { clock: deploymentClock, fetcher, pollMilliseconds: 1 },
    )

    expect(dispatchWorkflow).toHaveBeenCalledWith('deploy.yml', 'main')
    expect(findWorkflowRun).toHaveBeenLastCalledWith('deploy.yml', new Date('2026-08-08T15:00:00Z'))
    expect(getWorkflowRun).toHaveBeenCalledWith(73)
    expect(fetcher).toHaveBeenCalledWith('https://shiora.jp')
    expect(result).toMatchObject({ verified: true, lastModified: new Date('2026-08-08T15:00:02Z') })
    expect(deploymentClock.sleep).toHaveBeenCalledTimes(2)
  })

  it('fails verification when Last-Modified predates dispatch', async () => {
    const forge = makeFakeForge()
    forge.findWorkflowRun = async () => ({
      id: 74, createdAt: '2026-08-08T15:00:00Z', status: 'completed', conclusion: 'success',
    })

    const result = await deploy(
      { workflow: 'deploy.yml', url: 'https://shiora.jp' }, 'main', forge,
      {
        clock: clock('2026-08-08T15:00:00Z'),
        fetcher: async () => response('Sat, 08 Aug 2026 14:59:59 GMT'),
      },
    )

    expect(result.verified).toBe(false)
    expect(result.dispatchedAt).toEqual(new Date('2026-08-08T15:00:00Z'))
    expect(result.lastModified).toEqual(new Date('2026-08-08T14:59:59Z'))
  })

  it('fails verification when Last-Modified is absent', async () => {
    const forge = makeFakeForge()
    forge.findWorkflowRun = async () => ({
      id: 75, createdAt: '2026-08-08T15:00:00Z', status: 'completed', conclusion: 'success',
    })

    const result = await deploy(
      { workflow: 'deploy.yml', url: 'https://shiora.jp' }, 'main', forge,
      { clock: clock('2026-08-08T15:00:00Z'), fetcher: async () => response(null) },
    )

    expect(result.verified).toBe(false)
    expect(result.lastModified).toBeUndefined()
  })
})
