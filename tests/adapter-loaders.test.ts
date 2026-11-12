import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { externalAdapterSpecifier } from '../src/adapters/external.ts'
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
  it('resolves a backslash-prefixed relative selector to a file URL on every platform', () => {
    const root = fixtureRoot()
    const selector = '.\\custom\\forge.mjs'

    const specifier = externalAdapterSpecifier(selector, root)

    expect(specifier).toBe(pathToFileURL(resolve(root, selector)).href)
    expect(specifier.startsWith('file:')).toBe(true)
    expect(externalAdapterSpecifier('custom\\forge.mjs', root)).toBe('custom\\forge.mjs')
  })

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

  it('passes the named repositories to a forge factory', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'forge.mjs'), `
export function createForge(repoRoot, report, target) {
  return { target }
}
`)
    const target = { codeRepository: 'owner/app', issueRepository: 'owner/fleet' }

    const forge = await loadForge(`.${sep}forge.mjs`, root, () => {}, target)

    expect(forge).toMatchObject({ target })
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

  it('loads a ready-made forge from a default export', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'forge.mjs'), `
export default { selectedBy: 'forge default' }
export function createForge() {
  throw new Error('the default export must win over the factory')
}
`)

    const forge = await loadForge('./forge.mjs', root)

    expect(forge).toEqual({ selectedBy: 'forge default' })
  })

  it('loads a ready-made runner from a default export', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'runner.mjs'), `
export default { selectedBy: 'runner default', sharedSkills: {}, async start() { return 7 } }
export const runner = { selectedBy: 'runner export' }
`)

    const runner = await loadRunner('./runner.mjs', { env: {}, repoRoot: root })

    expect(runner).toMatchObject({ selectedBy: 'runner default' })
    await expect(runner.start({} as never)).resolves.toBe(7)
  })

  it('passes the loader options to a runner factory', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'runner.mjs'), `
export function createRunner(options) {
  return { selectedBy: 'runner factory', options, sharedSkills: {}, async start() { return 1 } }
}
`)
    const options = { env: { RUNNER_MODEL: 'pinned' }, repoRoot: root }

    const runner = await loadRunner('./runner.mjs', options)

    expect(runner).toMatchObject({ selectedBy: 'runner factory' })
    expect((runner as unknown as { options: unknown }).options).toBe(options)
  })

  it('awaits an asynchronous runner factory', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'runner.mjs'), `
export async function createRunner(options) {
  await new Promise((resolve) => setTimeout(resolve, 1))
  return { selectedBy: 'async runner factory', repoRoot: options.repoRoot, sharedSkills: {}, async start() { return 2 } }
}
`)

    const runner = await loadRunner('./runner.mjs', { env: {}, repoRoot: root })

    expect(runner).toMatchObject({ selectedBy: 'async runner factory', repoRoot: root })
    await expect(runner.start({} as never)).resolves.toBe(2)
  })

  it('awaits an asynchronous forge factory', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'forge.mjs'), `
export async function createForge(repoRoot) {
  await new Promise((resolve) => setTimeout(resolve, 1))
  return { selectedBy: 'async forge factory', repoRoot }
}
`)

    const forge = await loadForge('./forge.mjs', root)

    expect(forge).toEqual({ selectedBy: 'async forge factory', repoRoot: root })
  })

  it('reports the exports accepted from a loaded external forge module', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'empty.mjs'), 'export const unrelated = true\n')

    await expect(loadForge('./empty.mjs', root)).rejects.toThrow(
      "External FORGE './empty.mjs' must export default, forge, or createForge",
    )
  })

  it('names the supported forges when an external forge cannot be resolved', async () => {
    const root = fixtureRoot()

    const error = await loadForge('./missing.mjs', root).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    const { message, cause } = error as Error
    expect(cause).toBeInstanceOf(Error)
    expect(message).toBe(
      `Unknown FORGE './missing.mjs' (supported: github). Could not load external adapter: ${(cause as Error).message}`,
    )
  })

  it('names the supported runners when an external runner cannot be resolved', async () => {
    const root = fixtureRoot()

    const error = await loadRunner('./missing.mjs', { env: {}, repoRoot: root })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    const { message, cause } = error as Error
    expect(cause).toBeInstanceOf(Error)
    expect(message).toBe(
      `Unknown RUNNER './missing.mjs' (supported: codex, claude). Could not load external adapter: ${(cause as Error).message}`,
    )
  })

  it('reports the exports accepted from a loaded external module', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'empty.mjs'), 'export const unrelated = true\n')

    await expect(loadRunner('./empty.mjs', { env: {}, repoRoot: root })).rejects.toThrow(
      "External RUNNER './empty.mjs' must export default, runner, or createRunner",
    )
  })
})
