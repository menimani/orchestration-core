import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.ts')

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-cli-'))
  const init = spawnSync('git', ['init'], { cwd: repoRoot, windowsHide: true })
  expect(init.status).toBe(0)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function daemonFile(name: string): string {
  return join(repoRoot, 'orchestration', 'queue', name)
}

describe('loop daemon ownership', () => {
  it('removes the PID and issue marker after a startup failure', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop'], {
      cwd: repoRoot,
      env: { ...process.env, FORGE: 'missing', ISSUE_QUEUE_ENABLED: 'true' },
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown FORGE 'missing'")
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('issue-mode'))).toBe(false)
  })

  it('removes the PID and issue marker after a normal shutdown', () => {
    const result = spawnSync(process.execPath, [CLI, 'loop'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AUTO_PR: 'false',
        ISSUE_QUEUE_ENABLED: 'false',
        MAX_SCAN_CYCLES: '0',
      },
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[loop] End the loop.')
    expect(existsSync(daemonFile('loop.pid'))).toBe(false)
    expect(existsSync(daemonFile('issue-mode'))).toBe(false)
  })
})
