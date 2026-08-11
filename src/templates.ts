import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { OrchPaths } from './paths.ts'

const CORE_TEMPLATES_DIR = resolve(import.meta.dirname, '..', 'templates')

/** Resolve a consumer override first, then the default shipped with the core. */
export function templateFile(paths: OrchPaths, templateName: string): string {
  const projectTemplate = join(paths.root, 'templates', templateName)
  if (existsSync(projectTemplate)) return projectTemplate

  const coreTemplate = join(CORE_TEMPLATES_DIR, templateName)
  if (existsSync(coreTemplate)) return coreTemplate

  throw new Error(
    `Template not found: ${projectTemplate} (core default also not found: ${coreTemplate})`,
  )
}

export function readTemplate(paths: OrchPaths, templateName: string): string {
  return readFileSync(templateFile(paths, templateName), 'utf8')
}
