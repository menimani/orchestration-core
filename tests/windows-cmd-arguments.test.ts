import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cmdArgumentLine } from '../src/adapters/windows-process.ts'
import { PROCESS_TEST_TIMEOUT_MS } from './testProcess.ts'

// What cmd.exe makes of a command line is what this asserts, so there is nothing for
// another platform to run. vitest.config.ts leaves the file uncollected off Windows
// rather than collecting it and reporting a skip, which reads as a disabled test.

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const HOSTILE_ARGUMENTS = [
  'C:\\Users\\AT&T\\final-message.txt',
  'a|b', 'x<y>z', 'm^n', '(p)', '%PATH%', '50%', '!PATH!', '%~dp0', '%1',
  'two words', 'trailing\\', '', 'a,b;c=d',
]

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-cmd-arguments-'))
  fixtureRoots.push(root)
  writeFileSync(join(root, 'echo-arguments.js'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  // The shape npm writes for a package binary: the arguments arrive again through %*.
  writeFileSync(join(root, 'fake-agent.cmd'),
    '@ECHO off\r\nSETLOCAL\r\n"node" "%~dp0\\echo-arguments.js" %*\r\n')
  return root
}

function runThroughCmd(program: string, args: readonly string[], root: string): string {
  const result = spawnSync('cmd.exe', [cmdArgumentLine(program, args)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ''}` },
    timeout: PROCESS_TEST_TIMEOUT_MS,
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return result.stdout
}

it('delivers cmd metacharacters literally through an npm .cmd shim', () => {
  const root = fixture()
  expect(JSON.parse(runThroughCmd('fake-agent', HOSTILE_ARGUMENTS, root)))
    .toEqual(HOSTILE_ARGUMENTS)
}, PROCESS_TEST_TIMEOUT_MS)

it('delivers cmd metacharacters literally to a native executable', () => {
  const root = fixture()
  const script = join(root, 'echo-arguments.js')
  expect(JSON.parse(runThroughCmd('node', [script, ...HOSTILE_ARGUMENTS], root)))
    .toEqual(HOSTILE_ARGUMENTS)
}, PROCESS_TEST_TIMEOUT_MS)
