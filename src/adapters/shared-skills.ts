export interface SharedSkillRenderOptions {
  repoRoot: string
  packageRoot: string
  commandPrefixPlaceholder: string
  packagePathPrefixPlaceholder: string
}

/** One agent's repository-scoped skill discovery and rendering behavior. */
export interface SharedSkillsAdapter {
  /** Absolute directory where this agent discovers repository-scoped skills. */
  destinationRoot(repoRoot: string): string
  /** Absolute former discovery directories whose generated skills may be migrated. */
  legacyRoots?(repoRoot: string): string[]
  /** Render a canonical shared-skill file into this agent's on-disk format. */
  renderFile(contents: Buffer, options: SharedSkillRenderOptions): Buffer
}
