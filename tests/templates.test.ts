import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrchPaths } from '../src/paths.ts'
import { readTemplate, templateFile } from '../src/templates.ts'

let root: string
let paths: OrchPaths

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-templates-'))
  paths = { root: join(root, 'orchestration') } as OrchPaths
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('template resolution', () => {
  it('uses the core default when the project has no override', () => {
    expect(readTemplate(paths, 'task-requirements.md')).toContain('Before reporting this done')
    expect(templateFile(paths, 'task-requirements.md')).not.toBe(
      join(paths.root, 'templates', 'task-requirements.md'),
    )
  })

  it('prefers a project template over the core default', () => {
    const projectTemplate = join(paths.root, 'templates', 'review-template.md')
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(projectTemplate, 'Project review template.\n')

    expect(templateFile(paths, 'review-template.md')).toBe(projectTemplate)
    expect(readTemplate(paths, 'review-template.md')).toBe('Project review template.\n')
  })

  it('names the expected project path when neither location has the template', () => {
    const expected = join(paths.root, 'templates', 'scan-template.md')

    expect(() => readTemplate(paths, 'scan-template.md')).toThrow(`Template not found: ${expected}`)
  })
})
