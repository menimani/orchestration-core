import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WINDOWS_PROCESS_ROOT_PID_ENV } from '../src/adapters/windows-process.ts'
import {
  LOOP_RESTART_PREDECESSOR_PID_ENV, LOOP_RESTART_READY_FILE_ENV,
} from '../src/restart.ts'
import { execShellSync } from '../src/shell.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('project command environment', () => {
  it('keeps public settings while hiding private process-tree and restart markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'orchestration-shell-'))
    fixtureRoots.push(root)
    const script = join(root, 'environment.cjs')
    const output = join(root, 'environment.json')
    writeFileSync(script, `
const { writeFileSync } = require('node:fs')
writeFileSync(process.argv[2], JSON.stringify({
  processRoot: process.env.${WINDOWS_PROCESS_ROOT_PID_ENV},
  restartReady: process.env.${LOOP_RESTART_READY_FILE_ENV},
  restartPredecessor: process.env.${LOOP_RESTART_PREDECESSOR_PID_ENV},
  publicSetting: process.env.CORE_AUTO_UPDATE,
  commandContract: process.env.ORCH_TEST_COMMAND_CONTRACT,
}))
`)

    const markedEnvironment = {
      [WINDOWS_PROCESS_ROOT_PID_ENV]: '43210',
      [LOOP_RESTART_READY_FILE_ENV]: join(root, 'ready'),
      [LOOP_RESTART_PREDECESSOR_PID_ENV]: '43209',
      CORE_AUTO_UPDATE: 'false',
      ORCH_TEST_COMMAND_CONTRACT: 'visible',
    }
    const previous = new Map(
      Object.keys(markedEnvironment).map((name) => [name, process.env[name]]),
    )
    try {
      Object.assign(process.env, markedEnvironment)
      execShellSync(`node "${script}" "${output}"`, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      })
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      publicSetting: 'false',
      commandContract: 'visible',
    })
  })
})
