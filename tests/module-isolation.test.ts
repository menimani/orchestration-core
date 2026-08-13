import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyModuleIsolation } from '../src/moduleIsolation.ts'

describe('verifyModuleIsolation', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orch module-isolation-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const writeManifest = (manifest: unknown): void => {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  const install = (names: readonly string[], record = true): void => {
    const modules = join(root, 'node_modules')
    mkdirSync(modules, { recursive: true })
    if (record) writeFileSync(join(modules, '.package-lock.json'), '{}\n')
    for (const name of names) mkdirSync(join(modules, name), { recursive: true })
  }

  it('accepts a directory that satisfies every declared dependency itself', () => {
    writeManifest({ devDependencies: { vitest: '^3.0.0' }, dependencies: { zod: '^3.0.0' } })
    writeFileSync(join(root, 'package-lock.json'), '{}\n')
    install(['vitest', 'zod'])

    expect(verifyModuleIsolation(root)).toEqual({ isolated: true })
  })

  it('refuses a partial install, naming what would come from a parent directory', () => {
    writeManifest({ devDependencies: { vitest: '^3.0.0', typescript: '^5.0.0' } })
    install(['typescript'])

    const verdict = verifyModuleIsolation(root)

    expect(verdict.isolated).toBe(false)
    expect(verdict.reason).toContain('vitest')
    expect(verdict.reason).toContain('resolve from a parent directory')
  })

  it('refuses an install that never finished, even with every directory present', () => {
    writeManifest({ devDependencies: { vitest: '^3.0.0' } })
    writeFileSync(join(root, 'package-lock.json'), '{}\n')
    install(['vitest'], false)

    const verdict = verifyModuleIsolation(root)

    expect(verdict.isolated).toBe(false)
    expect(verdict.reason).toContain('completed-install record')
  })

  it('does not demand npm\'s install record where no npm lockfile owns the directory', () => {
    writeManifest({ devDependencies: { vitest: '^3.0.0' } })
    install(['vitest'], false)

    expect(verifyModuleIsolation(root)).toEqual({ isolated: true })
  })

  it('refuses a declared dependency set with no node_modules at all', () => {
    writeManifest({ dependencies: { zod: '^3.0.0' } })

    const verdict = verifyModuleIsolation(root)

    expect(verdict.isolated).toBe(false)
    expect(verdict.reason).toContain('node_modules is absent')
  })

  it('resolves scoped names against their own directory', () => {
    writeManifest({ devDependencies: { '@types/node': '^24.0.0' } })
    install(['@types/node'])

    expect(verifyModuleIsolation(root)).toEqual({ isolated: true })
  })

  it('accepts a directory that declares nothing and one that no manifest describes', () => {
    expect(verifyModuleIsolation(root)).toEqual({ isolated: true })
    writeManifest({ name: 'declares-nothing' })
    expect(verifyModuleIsolation(root)).toEqual({ isolated: true })
  })

  it('refuses a manifest it cannot read rather than assuming it declares nothing', () => {
    writeFileSync(join(root, 'package.json'), '{ not json\n')

    const verdict = verifyModuleIsolation(root)

    expect(verdict.isolated).toBe(false)
    expect(verdict.reason).toContain('could not be read')
  })
})
