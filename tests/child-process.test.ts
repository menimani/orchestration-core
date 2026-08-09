import { describe, expect, it } from 'vitest'
import { capturedSpawnOptions } from '../src/childProcess.ts'

describe('capturedSpawnOptions', () => {
  it('defaults daemon child processes to piped stdout and stderr', () => {
    expect(capturedSpawnOptions({ cwd: 'worktree' })).toEqual({
      cwd: 'worktree',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })
})
