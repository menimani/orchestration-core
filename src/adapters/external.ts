import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve filesystem selectors from the consumer repository without rewriting packages or URLs. */
export function externalAdapterSpecifier(selector: string, root: string): string {
  if (/^\.\.?[\\/]/.test(selector) || isAbsolute(selector)) {
    return pathToFileURL(resolve(root, selector)).href
  }
  return selector
}
