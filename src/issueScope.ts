import type { CreateIssueOptions, Forge, ForgeIssue } from './adapters/forge.ts'

// A fleet's issue queue is one repository shared by every project the fleet runs, so a
// project's loop must neither claim, deduplicate against, nor reap another project's
// issues. Each issue carries the label of the project that filed it, and every listing
// the queue reads is narrowed to that label before the queue sees it.

/** The label marking an issue in a shared queue as belonging to one project. */
export function projectScopeLabel(project: string): string {
  return `project:${project}`
}

/** Create the scope label in the queue repository when it is not there yet. */
export async function ensureScopeLabel(forge: Forge, label: string): Promise<boolean> {
  if ((await forge.listLabels()).includes(label)) return false
  await forge.createLabel(label, 'Loop issues filed by one fleet project')
  return true
}

/** A forge whose issue queue holds only the issues carrying the scope label. */
export function scopeForgeToProject(forge: Forge, label: string): Forge {
  const inScope = (issue: ForgeIssue): boolean => issue.labels.includes(label)
  // An issue cannot be filed with a label the repository lacks, and the first issue a
  // project files may come long after setup, so the label is ensured on demand.
  let labelReady: Promise<boolean> | undefined
  // Everything else is inherited rather than copied: a forge implemented as a class keeps
  // its methods on the prototype, where a copy of the object's own properties misses them.
  const scoped: Forge = Object.create(forge)
  return Object.assign(scoped, {
    async createIssue(options: CreateIssueOptions) {
      labelReady ??= ensureScopeLabel(forge, label).catch((error: unknown) => {
        labelReady = undefined
        throw error
      })
      await labelReady
      return forge.createIssue({ ...options, labels: [...options.labels, label] })
    },
    async listOpenIssues(queueLabel: string) {
      return (await forge.listOpenIssues(queueLabel)).filter(inScope)
    },
    async listClosedIssues(queueLabel: string) {
      return (await forge.listClosedIssues(queueLabel)).filter(inScope)
    },
  })
}
