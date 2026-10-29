import { existsSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

export function resolvedPath(path: string): string {
  const resolved = realpathSync.native(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Another spelling of an existing directory, as an operator might type it: the case
 * altered where the filesystem ignores case, otherwise a symlink created in linkDir.
 * Either way the spelling differs from the one Git reports for the same directory.
 */
export function nonCanonicalSpelling(path: string, linkDir: string): string {
  const altered = path.toUpperCase() === path ? path.toLowerCase() : path.toUpperCase()
  if (altered !== path && existsSync(altered)
    && realpathSync.native(altered) === realpathSync.native(path)) return altered
  const link = join(linkDir, 'alias')
  symlinkSync(path, link, 'junction')
  return link
}
