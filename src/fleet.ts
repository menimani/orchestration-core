import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { FleetLocation } from './paths.ts'

// A fleet is a separate checkout that holds what each target repository would otherwise
// carry under orchestration/: adapters, templates, config, runtime state. fleet.json is
// shared and tracked; fleet.local.json maps project names to this machine's checkouts,
// because the same fleet is cloned on every machine that runs a worker.

export const FLEET_FILE = 'fleet.json'
export const FLEET_LOCAL_FILE = 'fleet.local.json'

const projectName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)

const fleetSchema = z.object({
  issueRepository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  projects: z.record(projectName, z.object({
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  })),
})

const fleetLocalSchema = z.object({
  projects: z.record(projectName, z.object({ path: z.string().min(1) })),
})

export type FleetFile = z.infer<typeof fleetSchema>

function readJson<T>(file: string, schema: z.ZodType<T>): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, { cause: error })
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const at = issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`
    throw new Error(`Invalid ${file}${at}: ${issue?.message ?? 'schema mismatch'}`)
  }
  return result.data
}

/** The nearest directory at or above start that holds fleet.json, if any. */
export function findFleetDir(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, FLEET_FILE))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function readFleet(fleetDir: string): FleetFile {
  return readJson(join(fleetDir, FLEET_FILE), fleetSchema)
}

export interface ResolvedFleetProject {
  location: FleetLocation
  /** Where this machine keeps the target repository's checkout. */
  checkout: string
}

/** Resolve a project named in fleet.json to this machine's checkout of it. */
export function resolveFleetProject(fleetDir: string, project: string): ResolvedFleetProject {
  const dir = resolve(fleetDir)
  const fleet = readFleet(dir)
  const declared = fleet.projects[project]
  if (declared === undefined) {
    const known = Object.keys(fleet.projects).join(', ') || '(none)'
    throw new Error(`Project '${project}' is not declared in ${join(dir, FLEET_FILE)} (declared: ${known})`)
  }
  const localFile = join(dir, FLEET_LOCAL_FILE)
  if (!existsSync(localFile)) {
    throw new Error(`Missing ${localFile}: map '${project}' to this machine's checkout`)
  }
  const checkout = readJson(localFile, fleetLocalSchema).projects[project]?.path
  if (checkout === undefined) {
    throw new Error(`${localFile} has no path for project '${project}'`)
  }
  return {
    location: {
      dir,
      project,
      repository: declared.repository,
      issueRepository: fleet.issueRepository,
    },
    checkout: isAbsolute(checkout) ? checkout : resolve(dir, checkout),
  }
}
