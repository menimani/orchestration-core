import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeNpmCi, type SafeNpmCiRuntime } from '../orchestration/project/safe-npm-ci.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-safe-npm-ci-'))
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n')
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function runtime(overrides: Partial<SafeNpmCiRuntime> = {}): SafeNpmCiRuntime {
  return {
    install: vi.fn(),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    warn: vi.fn(),
    ...overrides,
  }
}

function writeDependency(modules: string, name: string, contents: string): string {
  const marker = join(modules, name, 'marker.txt')
  mkdirSync(join(modules, name), { recursive: true })
  writeFileSync(marker, contents)
  return marker
}

describe('safe npm clean install', () => {
  it('leaves the working dependency tree intact when the staged install fails', () => {
    const marker = writeDependency(join(root, 'node_modules'), 'working-dependency', 'working\n')
    const failed = runtime({
      install: () => { throw new Error('install failed') },
    })

    expect(() => safeNpmCi(root, failed)).toThrow('install failed')

    expect(readFileSync(marker, 'utf8')).toBe('working\n')
  })

  it('activates a complete staged dependency tree', () => {
    const oldMarker = writeDependency(join(root, 'node_modules'), 'old-dependency', 'old\n')
    const installed = runtime({
      install: (stagingRoot) => {
        writeDependency(join(stagingRoot, 'node_modules'), 'new-dependency', 'new\n')
      },
    })

    safeNpmCi(root, installed)

    expect(existsSync(oldMarker)).toBe(false)
    expect(readFileSync(join(root, 'node_modules', 'new-dependency', 'marker.txt'), 'utf8'))
      .toBe('new\n')
  })

  it('keeps the new tree usable when a busy old backup cannot be removed', () => {
    writeDependency(join(root, 'node_modules'), 'old-dependency', 'old\n')
    const warn = vi.fn()
    const guarded = runtime({
      install: (stagingRoot) => {
        writeDependency(join(stagingRoot, 'node_modules'), 'new-dependency', 'new\n')
      },
      remove: (path) => {
        if (path.includes('.node_modules.previous-')) throw new Error('esbuild.exe is busy')
        rmSync(path, { recursive: true, force: true })
      },
      warn,
    })

    safeNpmCi(root, guarded)

    expect(readFileSync(join(root, 'node_modules', 'new-dependency', 'marker.txt'), 'utf8'))
      .toBe('new\n')
    const backup = readdirSync(root).find((entry) => entry.startsWith('.node_modules.previous-'))
    expect(backup).toBeDefined()
    expect(readFileSync(join(root, backup!, 'old-dependency', 'marker.txt'), 'utf8'))
      .toBe('old\n')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('esbuild.exe is busy'))
  })
})
