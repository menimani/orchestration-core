import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A git process costs tens of milliseconds on Windows, and a file whose tests each
// build the same starting repository pays that hundreds of times over. A template is
// built once and copied, so every test still starts from a private repository of its
// own; only the commands that produce the identical starting state are shared.

export interface RepositoryTemplate<T> {
  /** What the build returned, such as the commit it created. */
  readonly value: T
  /** Copy the template's contents into an existing directory. */
  copyTo(destination: string): void
  /** Remove the template. */
  dispose(): void
}

/**
 * Build a template under a fresh directory. `checkouts` names each working tree inside
 * it, relative to its root; a copy refreshes their indexes, whose recorded file stats
 * belong to the template's files rather than to the copies.
 */
export function buildRepositoryTemplate<T>(
  build: (root: string) => T,
  checkouts: readonly string[] = ['.'],
): RepositoryTemplate<T> {
  const root = mkdtempSync(join(tmpdir(), 'orch-repository-template-'))
  try {
    const value = build(root)
    return {
      value,
      copyTo(destination) {
        cpSync(root, destination, { recursive: true })
        for (const checkout of checkouts) {
          execFileSync('git', ['update-index', '-q', '--refresh'], {
            cwd: join(destination, checkout),
            stdio: 'ignore',
            windowsHide: true,
          })
        }
      },
      dispose() {
        rmSync(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
