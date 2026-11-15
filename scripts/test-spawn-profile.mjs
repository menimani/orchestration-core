import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Aggregates the spawn profile a suite run writes when ORCH_TEST_SPAWN_PROFILE names a
// directory: one JSON file per test file, listing each child process its worker created
// (see tests/spawnProfile.ts). Prints a plain-text report to standard output.

const mostSpawnsPerTestCount = 20

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
  return lines.join('\n')
}

const directory = process.argv[2]
if (directory === undefined) {
  console.error('Usage: node scripts/test-spawn-profile.mjs <directory>')
  process.exitCode = 2
} else {
  console.log(report(directory))
}
