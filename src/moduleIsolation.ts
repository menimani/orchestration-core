import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A task worktree lives under the checkout it was cut from, so Node's module resolution
// walks up into the parent's node_modules for anything the worktree does not have. An
// install that stopped early therefore does not fail: the run silently mixes the two
// dependency trees. On 2026-08-13 that mixture ran a suite to a green summary and then
// crashed the process on teardown, failing three merges in a row while every test passed.
//
// Borrowing from the parent is never intended, so a directory that declares dependencies
// must satisfy them itself. Anything else stops the gate rather than running.

export interface ModuleIsolation {
  /** Whether the directory can run without reaching outside itself for dependencies. */
  isolated: boolean
  /** Why it cannot, phrased for the gate log. Absent when isolated. */
  reason?: string
}

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const MISSING_NAMES_REPORTED = 5

function declaredDependencies(manifest: Manifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]
}

/**
 * Report whether `directory` satisfies its declared dependencies locally. A directory
 * that declares none, or that no package manifest describes, has nothing to borrow.
 */
export function verifyModuleIsolation(directory: string): ModuleIsolation {
  const manifestFile = join(directory, 'package.json')
  if (!existsSync(manifestFile)) return { isolated: true }

  let manifest: Manifest
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { isolated: false, reason: `package.json could not be read: ${detail}` }
  }

  const declared = declaredDependencies(manifest)
  if (declared.length === 0) return { isolated: true }

  const modules = join(directory, 'node_modules')
  if (!existsSync(modules)) {
    return {
      isolated: false,
      reason: `${declared.length} dependencies are declared but node_modules is absent, `
        + 'so every one of them would resolve from a parent directory',
    }
  }

  // npm writes this record only once an install completes, which is what separates a
  // finished install from one that stopped partway. Other package managers do not write
  // it, so require it only where a lockfile shows npm owns the directory.
  if (existsSync(join(directory, 'package-lock.json'))
    && !existsSync(join(modules, '.package-lock.json'))) {
    return {
      isolated: false,
      reason: 'node_modules carries no completed-install record, so the install did not finish',
    }
  }

  const missing = declared.filter((name) => !existsSync(join(modules, name)))
  if (missing.length > 0) {
    const listed = missing.slice(0, MISSING_NAMES_REPORTED).join(', ')
    const rest = missing.length > MISSING_NAMES_REPORTED
      ? ` and ${missing.length - MISSING_NAMES_REPORTED} more`
      : ''
    return {
      isolated: false,
      reason: `${missing.length} declared dependencies are not installed here `
        + `(${listed}${rest}), so they would resolve from a parent directory`,
    }
  }

  return { isolated: true }
}
