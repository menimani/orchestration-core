import { join } from 'node:path'
import { packageCommandPrefix, packagePathPrefix } from '../paths.ts'
import type { SharedSkillsAdapter } from './shared-skills.ts'

/** Repository-scoped skill discovery and rendering for an interactive Claude agent. */
export function createClaudeSharedSkills(): SharedSkillsAdapter {
  return {
    destinationRoot: (repoRoot) => join(repoRoot, '.claude', 'skills'),
    renderFile: (contents, options) => Buffer.from(contents.toString('utf8')
      .replaceAll(
        options.commandPrefixPlaceholder,
        packageCommandPrefix(options.repoRoot, options.packageRoot),
      )
      .replaceAll(
        options.packagePathPrefixPlaceholder,
        packagePathPrefix(options.repoRoot, options.packageRoot),
      )),
  }
}
