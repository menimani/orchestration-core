import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { installRealGitGuard } from './realGitGuard.ts'
import { recordSpawnProfile } from './spawnProfile.ts'

// The fixtures drive real git repositories, and git reads the host's system and global
// configuration before a fixture's own. Git for Windows ships core.autocrlf=true in its
// system file, which rewrites the bytes a fixture checks out; a developer's
// commit.gpgsign or core.hooksPath would leak in the same way. Every git process the
// suite starts, directly or through the code under test, inherits this environment, so
// a fixture sees only the configuration it sets itself. A fixture that tests line-ending
// behaviour sets core.autocrlf explicitly.
//
// The file is not empty, though: it carries settings that only change how fast git
// writes. core.fsync=none skips flushing objects and refs to disk, and gc.auto=0 with
// maintenance.auto=false stops a commit or merge from starting background housekeeping.
// They change durability and housekeeping only, never what a command answers, and a
// fixture that sets its own value in its repository still wins over this file.
const configRoot = mkdtempSync(join(tmpdir(), 'orch-git-config-'))
const globalConfig = join(configRoot, 'gitconfig')
writeFileSync(globalConfig, [
  '[core]', '\tfsync = none',
  '[gc]', '\tauto = 0',
  '[maintenance]', '\tauto = false',
].join('\n') + '\n')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = globalConfig

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})

// Watches for real git started in a fake repository's root; tests/realGitGuard.ts says
// why. Installed before the profile, so the profile still attributes each child to the
// code that started it rather than to this guard.
installRealGitGuard(createRequire(import.meta.url)('node:child_process') as Record<string | symbol, unknown>)
syncBuiltinESMExports()

// Off unless ORCH_TEST_SPAWN_PROFILE names a directory. Installed here, before any test
// module loads, so it sees every child process the file and the code under test create.
recordSpawnProfile(process.env)
