import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// The fixtures drive real git repositories, and git reads the host's system and global
// configuration before a fixture's own. Git for Windows ships core.autocrlf=true in its
// system file, which rewrites the bytes a fixture checks out; a developer's
// commit.gpgsign or core.hooksPath would leak in the same way. Every git process the
// suite starts, directly or through the code under test, inherits this environment, so
// a fixture sees only the configuration it sets itself. A fixture that tests line-ending
// behaviour sets core.autocrlf explicitly.
const configRoot = mkdtempSync(join(tmpdir(), 'orch-git-config-'))
const globalConfig = join(configRoot, 'gitconfig')
writeFileSync(globalConfig, '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = globalConfig

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})
