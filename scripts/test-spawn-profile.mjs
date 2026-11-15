import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Aggregates the spawn profile a suite run writes when ORCH_TEST_SPAWN_PROFILE names a
// directory: one JSON file per test file, listing each child process its worker created
// (see tests/spawnProfile.ts). Prints a plain-text report to standard output.

const mostSpawnsPerTestCount = 20
const callSiteCount = 40

// Who asked for a child, by the file of its caller: the product code, the helpers the
// test files share, or a test file itself. A record without a caller, or one from a
// script or a fixture, is `other`, so the rows always add up to the totals.
const origins = ['src/', 'shared test helpers', 'test files', 'other']

function originOf(caller) {
  const file = caller?.replace(/:\d+$/, '') ?? ''
  if (file.startsWith('src/')) return 'src/'
  if (/^tests\/[^/]*\.test\.[cm]?[jt]s$/.test(file)) return 'test files'
  if (file.startsWith('tests/')) return 'shared test helpers'
  return 'other'
}

// A git child asked the same question as the git child before it in the same test: the
// same arguments in the same directory, with no other git process started in between.
function repeatedGitQuestions(profiles) {
  const repeated = []
  for (const profile of profiles) {
    const byTest = new Map()
    const gitSpawns = profile.spawns
      .filter((spawn) => spawn.executable === 'git' && typeof spawn.test === 'string' && Array.isArray(spawn.argv))
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
    for (const spawn of gitSpawns) {
      const question = JSON.stringify([spawn.cwd ?? null, spawn.argv])
      if (byTest.get(spawn.test) === question) repeated.push(spawn)
      byTest.set(spawn.test, question)
    }
  }
  return repeated
}

// Groups spawns by caller, the frame that called into it, executable and subcommand.
function byCallSite(spawns) {
  const sites = new Map()
  for (const spawn of spawns) {
    const key = [spawn.caller ?? '', spawn.via ?? '', spawn.executable, spawn.subcommand ?? ''].join('\u0000')
    const site = sites.get(key) ?? {
      caller: spawn.caller ?? '-', via: spawn.via ?? '-', executable: spawn.executable, subcommand: spawn.subcommand, count: 0, total: 0,
    }
    site.count += 1
    site.total += spawn.durationMs
    sites.set(key, site)
  }
  return [...sites.values()].sort((left, right) => right.total - left.total)
}

function milliseconds(value) {
  return `${Math.round(value)}ms`
}

function seconds(value) {
  return `${(value / 1000).toFixed(1)}s`
}

function percent(part, whole) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : '-'
}

// Left-aligns the leading text columns and right-aligns the numbers after them.
function table(header, rows, textColumns = 1) {
  const widths = header.map((title, column) => Math.max(
    title.length, ...rows.map((row) => String(row[column]).length),
  ))
  const format = (row) => row.map((cell, column) => (
    column < textColumns ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])
  )).join('  ').trimEnd()
  return [format(header), ...rows.map(format)]
}

function readProfiles(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')))
}

function report(directory) {
  const profiles = readProfiles(directory)
  const spawns = profiles.flatMap((profile) => profile.spawns)
  const childTime = spawns.reduce((sum, spawn) => sum + spawn.durationMs, 0)
  const stillRunning = spawns.filter((spawn) => !spawn.exited).length
  const lines = [
    `Spawn profile of ${profiles.length} test files in ${directory}`,
    'Counts the child processes each test worker created through node:child_process.',
    'Processes started by a child CLI are outside the worker and are not counted.',
    'Child wall time adds up overlapping children, so a share above 100% is possible.',
    '',
    `Total spawns: ${spawns.length}${stillRunning > 0 ? ` (${stillRunning} still running when their file finished)` : ''}`,
    `Total child wall time: ${seconds(childTime)}`,
  ]

  const byCommand = new Map()
  for (const spawn of spawns) {
    const key = `${spawn.executable}\u0000${spawn.subcommand ?? ''}`
    const entry = byCommand.get(key) ?? { executable: spawn.executable, subcommand: spawn.subcommand, count: 0, total: 0 }
    entry.count += 1
    entry.total += spawn.durationMs
    byCommand.set(key, entry)
  }
  lines.push('', 'By executable and subcommand', ...table(
    ['executable', 'subcommand', 'count', 'total', 'mean'],
    [...byCommand.values()]
      .sort((left, right) => right.total - left.total)
      .map(({ executable, subcommand, count, total }) => [
        executable, subcommand ?? '-', count, seconds(total), milliseconds(total / count),
      ]),
    2,
  ))

  const files = profiles.map((profile) => {
    const fileChildTime = profile.spawns.reduce((sum, spawn) => sum + spawn.durationMs, 0)
    return {
      file: profile.file,
      tests: profile.tests,
      spawns: profile.spawns.length,
      perTest: profile.tests > 0 ? profile.spawns.length / profile.tests : profile.spawns.length,
      childTime: fileChildTime,
      share: percent(fileChildTime, profile.durationMs),
    }
  })
  const fileRow = ({ file, tests, spawns: count, perTest, childTime: time, share }) => [
    file, tests, count, perTest.toFixed(1), seconds(time), share,
  ]
  const fileHeader = ['test file', 'tests', 'spawns', 'spawns/test', 'child time', 'share of file']
  lines.push('', 'By test file', ...table(
    fileHeader,
    [...files].sort((left, right) => right.childTime - left.childTime).map(fileRow),
  ))
  lines.push('', `Most spawns per test (top ${mostSpawnsPerTestCount})`, ...table(
    fileHeader,
    [...files].sort((left, right) => right.perTest - left.perTest).slice(0, mostSpawnsPerTestCount).map(fileRow),
  ))

  const byOrigin = new Map(origins.map((origin) => [origin, { count: 0, total: 0 }]))
  for (const spawn of spawns) {
    const entry = byOrigin.get(originOf(spawn.caller))
    entry.count += 1
    entry.total += spawn.durationMs
  }
  lines.push('', 'By origin of the caller', ...table(
    ['origin', 'spawns', 'child time', 'share'],
    origins.map((origin) => {
      const { count, total } = byOrigin.get(origin)
      return [origin, count, seconds(total), percent(total, childTime)]
    }),
  ))

  lines.push('', `Call sites with the most child wall time (top ${callSiteCount})`, ...table(
    ['caller', 'via', 'executable', 'subcommand', 'count', 'total', 'mean'],
    byCallSite(spawns).slice(0, callSiteCount).map(({ caller, via, executable, subcommand, count, total }) => [
      caller, via, executable, subcommand ?? '-', count, seconds(total), milliseconds(total / count),
    ]),
    4,
  ))

  const repeated = repeatedGitQuestions(profiles)
  const repeatedTime = repeated.reduce((sum, spawn) => sum + spawn.durationMs, 0)
  lines.push(
    '',
    `Repeated git questions (top ${callSiteCount} call sites)`,
    'A git child with the same arguments and directory as the git child just before it in the same test.',
    `Repeated: ${repeated.length} spawns, ${seconds(repeatedTime)}`,
    ...table(
      ['caller', 'via', 'subcommand', 'repeats', 'total'],
      byCallSite(repeated).slice(0, callSiteCount).map(({ caller, via, subcommand, count, total }) => [
        caller, via, subcommand ?? '-', count, seconds(total),
      ]),
      3,
    ),
  )
  return lines.join('\n')
}

const directory = process.argv[2]
if (directory === undefined) {
  console.error('Usage: node scripts/test-spawn-profile.mjs <directory>')
  process.exitCode = 2
} else {
  console.log(report(directory))
}
