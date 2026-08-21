import { realpathSync } from 'node:fs'

export function resolvedPath(path: string): string {
  const resolved = realpathSync.native(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
