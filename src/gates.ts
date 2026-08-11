import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

// Which commands verify a merge, and when, is project knowledge — it lives in the
// project adapter (orchestration/project/project-<name>.ts), not here. The rest of this
// file is orchestration-generic.

// Maps a finding's tag to the pitfall list its implementer checks a diff against.
// The lists are curated by hand: at most 20 entries each, a pattern admitted only
// after reviews flagged it twice, the lowest-impact entry dropped at the cap and
// restored past the cap when a dropped pattern recurs.
export function pitfallsFileForDesc(paths: OrchPaths, description: string): string {
  const name = description.startsWith('[TEST]') ? 'tests'
    : description.startsWith('[DOCS]') ? 'docs'
      : 'code'
  return join(paths.root, 'templates', 'pitfalls', `${name}.md`)
}
