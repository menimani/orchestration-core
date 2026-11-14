import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve filesystem selectors from the consumer repository without rewriting packages or URLs. */
export function externalAdapterSpecifier(selector: string, root: string): string {
  // Fleet configuration is shared across platforms, so a relative selector written on
  // Windows must name the same file on POSIX, where `\` is a file-name character.
  if (/^\.\.?[\\/]/.test(selector)) {
    return pathToFileURL(resolve(root, selector.replaceAll('\\', '/'))).href
  }
  if (isAbsolute(selector)) return pathToFileURL(resolve(root, selector)).href
  return selector
}
