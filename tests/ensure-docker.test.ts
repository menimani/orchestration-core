import { describe, expect, it, vi } from 'vitest'
import { ensureDocker } from '../scripts/ensure-docker.ts'

describe('ensureDocker', () => {
  it('does not start Docker when the daemon is already ready', async () => {
    const run = vi.fn(() => true)

    await ensureDocker({ run })

    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('docker', ['info', '--format', '{{.ServerVersion}}'], 5_000)
  })

  it('starts Docker Desktop on Windows and waits for the daemon', async () => {
    const run = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const launch = vi.fn()
    const delay = vi.fn(async () => undefined)

    await ensureDocker({
      run,
      launch,
      delay,
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: () => true,
    })

    expect(run).toHaveBeenNthCalledWith(2, 'docker', ['desktop', 'start'], 120_000)
    expect(launch).toHaveBeenCalledWith(
      expect.stringMatching(/Docker[\\/]Docker[\\/]Docker Desktop\.exe$/),
    )
    expect(delay).toHaveBeenCalledWith(5_000)
    expect(run).toHaveBeenLastCalledWith(
      'docker', ['info', '--format', '{{.ServerVersion}}'], 5_000,
    )
  })

  it('fails before a scan starts when no Docker runtime can be started', async () => {
    await expect(ensureDocker({
      run: () => false,
      platform: 'win32',
      env: {},
      exists: () => false,
    })).rejects.toThrow('Install Docker Desktop or Docker Engine')
  })
})
