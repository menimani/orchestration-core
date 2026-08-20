import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadForge } from '../src/adapters/forge.ts'
import { loadRunner } from '../src/adapters/runner.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'external-adapter-'))
  fixtureRoots.push(root)
  return root
}

describe('external adapter selectors', () => {
  it('loads a forge factory from a path relative to the repository', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'forge.mjs'), `
export function createForge(repoRoot, report) {
  report('external forge loaded')
  return { selectedBy: 'forge factory', repoRoot }
}
`)
    const report = vi.fn()

    const forge = await loadForge(`.${sep}forge.mjs`, root, report)

    expect(forge).toMatchObject({ selectedBy: 'forge factory', repoRoot: root })
    expect(report).toHaveBeenCalledWith('external forge loaded')
  })

  it('loads a runner implementation from an absolute path', async () => {
    const root = fixtureRoot()
    const adapterPath = join(root, 'runner.mjs')
    writeFileSync(adapterPath, `
export const runner = {
  selectedBy: 'runner export',
  sharedSkills: {},
  async start() { return 123 }
}
`)

    const runner = await loadRunner(adapterPath, { env: {}, repoRoot: root })

    expect(runner).toMatchObject({ selectedBy: 'runner export' })
    await expect(runner.start({} as never)).resolves.toBe(123)
  })

  it('reports the exports accepted from a loaded external module', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'empty.mjs'), 'export const unrelated = true\n')

    await expect(loadRunner('./empty.mjs', { env: {}, repoRoot: root })).rejects.toThrow(
      "External RUNNER './empty.mjs' must export default, runner, or createRunner",
    )
  })
})
