import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClaudeRunner } from '../src/adapters/runner-claude.ts'
import type { ReasoningEffort } from '../src/adapters/runner.ts'
import { CONFIG_ENV_NAMES, loadConfig, type LoopConfig } from '../src/config.ts'

// README.md and SPEC.md each copy the configuration defaults into a
// `| Variable | Default |` table by hand. These tests hold both tables to the values the
// source actually resolves, so a changed default cannot leave either document behind.

const packageRoot = resolve(import.meta.dirname, '..')

const RUNNER_MODEL_EFFORTS: Readonly<Record<string, ReasoningEffort>> = {
  RUNNER_CLAUDE_MODEL_MINIMAL: 'minimal',
  RUNNER_CLAUDE_MODEL_LOW: 'low',
  RUNNER_CLAUDE_MODEL_MEDIUM: 'medium',
  RUNNER_CLAUDE_MODEL_HIGH: 'high',
}
// Read by `report-upstream` straight from the environment; not a loop setting.
const ENVIRONMENT_ONLY = new Set(['UPSTREAM_REPO'])

const CONFIG_KEY_BY_NAME: ReadonlyMap<string, keyof LoopConfig> = new Map(
  (Object.keys(CONFIG_ENV_NAMES) as (keyof LoopConfig)[])
    .map((key) => [CONFIG_ENV_NAMES[key], key] as const),
)
const KNOWN_NAMES = new Set<string>([
  ...CONFIG_KEY_BY_NAME.keys(),
  'RUNNER_CLAUDE_MODEL',
  ...Object.keys(RUNNER_MODEL_EFFORTS),
  ...ENVIRONMENT_ONLY,
])

interface DocumentedDefault {
  name: string
  value: string
}

function documentedDefaults(file: string): DocumentedDefault[] {
  const lines = readFileSync(resolve(packageRoot, file), 'utf8').split(/\r?\n/)
  const header = lines.findIndex((line) => /^\| Variable \| Default \|/.test(line))
  if (header === -1) throw new Error(`${file} has no | Variable | Default | table`)
  const rows: DocumentedDefault[] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    const [variableCell, defaultCell] = line.split('|').slice(1, 3).map((cell) => cell.trim())
    const tokens = [...variableCell!.matchAll(/`([A-Z0-9_]+)`/g)].map((match) => match[1]!)
    // README abbreviates a family as `RUNNER_CLAUDE_MODEL_MINIMAL` / `LOW` / ...
    const prefix = tokens[0]!.slice(0, tokens[0]!.lastIndexOf('_') + 1)
    const names = tokens.map((token) => KNOWN_NAMES.has(token) ? token : `${prefix}${token}`)
    const values = defaultCell!.split(' / ')
    names.forEach((name, index) => {
      rows.push({ name, value: values.length === names.length ? values[index]! : defaultCell! })
    })
  }
  return rows
}

function normalizedDefault(value: string): string {
  const text = value.replaceAll('`', '').trim()
  if (text === 'empty') return ''
  if (text === 'package upstreamRepo') {
    const metadata = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { upstreamRepo: string }
    return metadata.upstreamRepo
  }
  return text
}

describe.each(['README.md', 'SPEC.md'])('%s configuration table', (file) => {
  const rows = documentedDefaults(file)

  it('names only settings the source reads', () => {
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.map((row) => row.name).filter((name) => !KNOWN_NAMES.has(name))).toEqual([])
  })

  it('states the defaults loadConfig resolves for an empty environment', () => {
    const config = loadConfig({}, { filePath: false })
    const documented = rows
      .filter((row) => CONFIG_KEY_BY_NAME.has(row.name))
      .map((row) => [row.name, normalizedDefault(row.value)])
    const actual = documented
      .map(([name]) => [name, String(config[CONFIG_KEY_BY_NAME.get(name!)!])])
    expect(documented).toEqual(actual)
  })

  it('states the base Claude model the runner falls back to', () => {
    const runner = createClaudeRunner({ env: {} })
    for (const row of rows.filter((candidate) => candidate.name === 'RUNNER_CLAUDE_MODEL')) {
      for (const effort of Object.values(RUNNER_MODEL_EFFORTS)) {
        expect(runner.resolveModel!({ effort })).toBe(normalizedDefault(row.value))
      }
    }
  })

  it('states that each per-effort Claude model falls back to the base model', () => {
    const effortRows = rows.filter((row) => row.name in RUNNER_MODEL_EFFORTS)
    expect(effortRows.map((row) => row.name).sort())
      .toEqual(Object.keys(RUNNER_MODEL_EFFORTS).sort())
    for (const row of effortRows) {
      const effort = RUNNER_MODEL_EFFORTS[row.name]!
      expect(normalizedDefault(row.value)).toBe('RUNNER_CLAUDE_MODEL')
      expect(createClaudeRunner({ env: { RUNNER_CLAUDE_MODEL: 'base-model' } })
        .resolveModel!({ effort })).toBe('base-model')
      expect(createClaudeRunner({ env: { [row.name]: 'effort-model' } })
        .resolveModel!({ effort })).toBe('effort-model')
    }
  })
})
