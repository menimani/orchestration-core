import { execSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdtempSync, renameSync, rmSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL_INPUTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc']

export interface SafeNpmCiRuntime {
  install: (root: string) => void
  remove: (path: string) => void
  warn: (message: string) => void
}

const systemRuntime: SafeNpmCiRuntime = {
  install: (root) => {
    execSync('npm ci --no-audit --no-fund', {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    })
  },
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  warn: console.warn,
}

/** Build a complete dependency tree before replacing the checkout's working one. */
export function safeNpmCi(
  root: string = process.cwd(),
  runtime: SafeNpmCiRuntime = systemRuntime,
): void {
  const nodeModules = join(root, 'node_modules')
  const stagingRoot = mkdtempSync(join(root, '.orchestration-npm-ci-'))
  const stagedModules = join(stagingRoot, 'node_modules')
  const previousModules = join(
    dirname(nodeModules),
    `.${basename(nodeModules)}.previous-${process.pid}-${Date.now()}`,
  )
  let previousMoved = false
  let activated = false

  try {
    for (const input of INSTALL_INPUTS) {
      const source = join(root, input)
      if (existsSync(source)) copyFileSync(source, join(stagingRoot, input))
    }
    runtime.install(stagingRoot)
    if (!existsSync(stagedModules)) {
      throw new Error('npm ci completed without producing node_modules')
    }

    // We rely on staging and activation, not a delete preflight: npm never touches the
    // working node_modules, and a busy old tree either cannot be renamed (leaving it
    // intact) or becomes an expendable backup after a complete new tree is activated.
    if (existsSync(nodeModules)) {
      renameSync(nodeModules, previousModules)
      previousMoved = true
    }
    try {
      renameSync(stagedModules, nodeModules)
      activated = true
    } catch (error) {
      if (previousMoved && !existsSync(nodeModules)) renameSync(previousModules, nodeModules)
      throw error
    }

    if (previousMoved) {
      try {
        runtime.remove(previousModules)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        runtime.warn(`Installed dependencies; old dependency backup remains at ${previousModules}: ${detail}`)
      }
    }
  } finally {
    // Once activation succeeds the staged directory no longer contains node_modules.
    // On every failure the checkout's original tree is either untouched or restored.
    try {
      runtime.remove(stagingRoot)
    } catch (error) {
      if (!activated) throw error
      const detail = error instanceof Error ? error.message : String(error)
      runtime.warn(`Installed dependencies; staging cleanup remains at ${stagingRoot}: ${detail}`)
    }
  }
}

const invokedFile = process.argv[1]
if (invokedFile !== undefined && resolve(invokedFile) === fileURLToPath(import.meta.url)) {
  safeNpmCi()
}
