import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findFleetDir, readFleet, resolveFleetProject } from '../src/fleet.ts'
import {
  absolutePackageScriptCommand, fleetPaths, locationArgs, orchPaths,
} from '../src/paths.ts'

const roots: string[] = []

function fleetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchestration-fleet-'))
  roots.push(dir)
  return dir
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('fleet manifest', () => {
  it('is found from a directory below the fleet root', () => {
    const dir = fleetDir()
    writeJson(join(dir, 'fleet.json'), { projects: {} })
    const nested = join(dir, 'projects', 'example')
    mkdirSync(nested, { recursive: true })

    expect(findFleetDir(nested)).toBe(dir)
  })

  it('names the file and the offending field when the manifest is invalid', () => {
    const dir = fleetDir()
    writeJson(join(dir, 'fleet.json'), { projects: { example: { repository: 'no-owner' } } })

    expect(() => readFleet(dir)).toThrow(/Invalid .*fleet\.json at projects\.example\.repository/)
  })

  it('rejects a project name that is not a lowercase slug', () => {
    const dir = fleetDir()
    writeJson(join(dir, 'fleet.json'), { projects: { 'Bad Name': { repository: 'owner/repo' } } })

    expect(() => readFleet(dir)).toThrow(/Invalid .*fleet\.json/)
  })
})

describe('fleet project resolution', () => {
  it('maps a declared project to this machine\'s checkout', () => {
    const dir = fleetDir()
    writeJson(join(dir, 'fleet.json'), {
      issueRepository: 'owner/fleet',
      projects: { example: { repository: 'owner/example' } },
    })
    writeJson(join(dir, 'fleet.local.json'), { projects: { example: { path: '../example' } } })

    expect(resolveFleetProject(dir, 'example')).toEqual({
      location: {
        dir, project: 'example', repository: 'owner/example', issueRepository: 'owner/fleet',
      },
      checkout: join(dir, '..', 'example'),
    })
  })

  it('lists the declared projects when the requested one is unknown', () => {
    const dir = fleetDir()
    writeJson(join(dir, 'fleet.json'), {
      projects: { first: { repository: 'owner/first' }, second: { repository: 'owner/second' } },
    })

    expect(() => resolveFleetProject(dir, 'third'))
      .toThrow("Project 'third' is not declared in")
    expect(() => resolveFleetProject(dir, 'third')).toThrow('(declared: first, second)')
  })

  it('requires the machine-local file and an entry for the project', () => {
    const dir = fleetDir()
    writeJson(join(dir, 'fleet.json'), { projects: { example: { repository: 'owner/example' } } })

    expect(() => resolveFleetProject(dir, 'example')).toThrow(/Missing .*fleet\.local\.json/)

    writeJson(join(dir, 'fleet.local.json'), { projects: {} })
    expect(() => resolveFleetProject(dir, 'example'))
      .toThrow("has no path for project 'example'")
  })
})

describe('fleet paths', () => {
  it('keeps runtime state and project assets in the fleet, not the checkout', () => {
    const dir = fleetDir()
    const checkout = join(dir, 'checkout')
    const paths = fleetPaths({ dir, project: 'example', repository: 'owner/example' }, checkout, false)

    expect(paths).toEqual({
      root: join(dir, 'state', 'example'),
      projectRoot: join(dir, 'projects', 'example'),
      repoRoot: checkout,
      tasksDir: join(dir, 'state', 'example', 'tasks'),
      worktreesDir: join(dir, 'state', 'example', 'worktrees'),
      statusDir: join(dir, 'state', 'example', 'status'),
      logsDir: join(dir, 'state', 'example', 'logs'),
      queueDir: join(dir, 'state', 'example', 'queue'),
      fleet: { dir, project: 'example', repository: 'owner/example' },
    })
  })

  it('shares one directory for state and assets in the in-repository layout', () => {
    const repository = fleetDir()
    const paths = orchPaths(repository, false)

    expect(paths.projectRoot).toBe(paths.root)
    expect(paths.fleet).toBeUndefined()
  })

  it('selects the same project again from any working directory', () => {
    const dir = fleetDir()
    const fleet = fleetPaths({ dir, project: 'example', repository: 'owner/example' }, join(dir, 'checkout'), false)
    const repository = orchPaths(join(dir, 'repository'), false)

    expect(locationArgs(fleet)).toEqual(['--fleet', dir, '--project', 'example'])
    expect(locationArgs(repository)).toEqual(['--repo', join(dir, 'repository')])
  })

  it('quotes path arguments but not flags in a copyable command', () => {
    const command = absolutePackageScriptCommand(
      ['--fleet', 'C:\\fleet dir', '--project', 'example'],
      'stop',
      'C:\\pkg',
    )

    expect(command).toBe("npm run -C 'C:/pkg' stop -- --fleet 'C:/fleet dir' --project 'example'")
  })
})
