import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findFleetDir, projectForDirectory, readFleet, resolveFleetProject } from '../src/fleet.ts'
import {
  absolutePackageScriptCommand, fleetPaths, locationArgs, orchPaths, shellPathSpelling,
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

  it.runIf(sep === '\\')('quotes path arguments but not flags in a copyable command', () => {
    const command = absolutePackageScriptCommand(
      ['--fleet', 'C:\\fleet dir', '--project', 'example'],
      'stop',
      'C:\\pkg',
    )

    expect(command).toBe("npm run -C 'C:/pkg' stop -- --fleet 'C:/fleet dir' --project 'example'")
  })

  it.runIf(sep === '/')('keeps a POSIX backslash as part of the name in a copyable command', () => {
    const command = absolutePackageScriptCommand(
      ['--fleet', '/srv/fleet\\v2', '--project', 'example'],
      'stop',
      '/srv/core\\v2',
    )

    expect(command).toBe(
      "npm run -C '/srv/core\\v2' stop -- --fleet '/srv/fleet\\v2' --project 'example'",
    )
  })

  it('rewrites backslashes only where they separate path components', () => {
    expect(shellPathSpelling('C:\\fleet\\core', '\\')).toBe('C:/fleet/core')
    expect(shellPathSpelling('/srv/core\\v2', '/')).toBe('/srv/core\\v2')
  })
})

describe('project for a directory', () => {
  function fleetWithCheckouts(): string {
    const dir = fleetDir()
    writeJson(join(dir, 'fleet.json'), {
      projects: {
        outer: { repository: 'owner/outer' },
        inner: { repository: 'owner/inner' },
        unmapped: { repository: 'owner/unmapped' },
      },
    })
    writeJson(join(dir, 'fleet.local.json'), {
      projects: {
        outer: { path: 'checkouts/outer' },
        inner: { path: 'checkouts/outer/vendor/inner' },
        stale: { path: 'checkouts/stale' },
      },
    })
    mkdirSync(join(dir, 'checkouts', 'outer', 'vendor', 'inner', 'src'), { recursive: true })
    mkdirSync(join(dir, 'checkouts', 'stale'), { recursive: true })
    return dir
  }

  it('finds the deepest checkout that contains the directory', () => {
    const dir = fleetWithCheckouts()

    expect(projectForDirectory(dir, join(dir, 'checkouts', 'outer'))).toBe('outer')
    expect(projectForDirectory(dir, join(dir, 'checkouts', 'outer', 'vendor'))).toBe('outer')
    expect(projectForDirectory(dir, join(dir, 'checkouts', 'outer', 'vendor', 'inner', 'src')))
      .toBe('inner')
  })

  it('finds nothing outside the checkouts or for a project the manifest dropped', () => {
    const dir = fleetWithCheckouts()

    expect(projectForDirectory(dir, join(dir, 'checkouts'))).toBeUndefined()
    expect(projectForDirectory(dir, join(dir, 'checkouts', 'outer-sibling'))).toBeUndefined()
    expect(projectForDirectory(dir, join(dir, 'checkouts', 'stale'))).toBeUndefined()
  })
})
