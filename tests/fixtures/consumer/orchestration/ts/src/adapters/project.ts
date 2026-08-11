// This type-only bridge lets the checked-in consumer adapter participate in the core's
// typecheck. The smoke test replaces the bridge with the package's actual source tree.
export type * from '../../../../../../../src/adapters/project.ts'
