import { platformCoverageReport } from './platformCoverage.ts'

// Printed once per run, before the summary a reader will judge the run by, so a run that
// could not attempt a suite says which one and why rather than reporting a count that
// looks the same as a run where nothing was left out.
export function setup(): void {
  console.log(platformCoverageReport())
}
