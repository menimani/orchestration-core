import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loopLogLines, prepareLoopLog } from '../src/loopLog.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'

let repoRoot: string
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-loop-log-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('prepareLoopLog', () => {
  it('rotates a previous run and stamps the new branch', () => {
    writeFileSync(join(paths.logsDir, 'loop.log'), 'previous output\n')
    writeFileSync(join(paths.logsDir, 'loop.log.branch'), 'feature/previous-run\n')
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'feature/current-run\n')

    prepareLoopLog(paths, { now: new Date(2026, 7, 9, 18, 59, 36) })

    const archive = join(paths.logsDir, 'loop-feature-previous-run-20260809_185936.log')
    expect(readFileSync(archive, 'utf8')).toBe('previous output\n')
    expect(readFileSync(join(paths.logsDir, 'loop.log'), 'utf8')).toBe('')
    expect(readFileSync(join(paths.logsDir, 'loop.log.branch'), 'utf8'))
      .toBe('feature/current-run\n')
  })

  it('keeps appending on a restart of the same run branch', () => {
    writeFileSync(join(paths.logsDir, 'loop.log'), 'before restart\n')
    writeFileSync(join(paths.logsDir, 'loop.log.branch'), 'feature/current-run\n')
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'feature/current-run\n')

    prepareLoopLog(paths, { now: new Date(2026, 7, 9, 18, 59, 36) })
    appendFileSync(join(paths.logsDir, 'loop.log'), 'after restart\n')

    expect(readFileSync(join(paths.logsDir, 'loop.log'), 'utf8'))
      .toBe('before restart\nafter restart\n')
    expect(existsSync(
      join(paths.logsDir, 'loop-feature-current-run-20260809_185936.log'),
    )).toBe(false)
  })

  it('archives an unmarked legacy log under the recorded run branch', () => {
    writeFileSync(join(paths.logsDir, 'loop.log'), 'legacy output\n')
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'feature/current-run\n')

    prepareLoopLog(paths, { now: new Date(2026, 7, 9, 18, 59, 36) })

    expect(readFileSync(
      join(paths.logsDir, 'loop-feature-current-run-20260809_185936.log'),
      'utf8',
    )).toBe('legacy output\n')
    expect(readFileSync(join(paths.logsDir, 'loop.log.branch'), 'utf8'))
      .toBe('feature/current-run\n')
  })

  it('uses the branch being started when the recorded branch has not updated yet', () => {
    writeFileSync(join(paths.logsDir, 'loop.log'), 'previous output\n')
    writeFileSync(join(paths.logsDir, 'loop.log.branch'), 'feature/previous-run\n')
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'feature/previous-run\n')

    prepareLoopLog(paths, {
      now: new Date(2026, 7, 9, 18, 59, 36),
      runBranch: 'feature/current-run',
    })

    expect(readFileSync(
      join(paths.logsDir, 'loop-feature-previous-run-20260809_185936.log'),
      'utf8',
    )).toBe('previous output\n')
    expect(readFileSync(join(paths.logsDir, 'loop.log.branch'), 'utf8'))
      .toBe('feature/current-run\n')
  })

  it('archives an unmarked daemon log under the previously recorded branch', () => {
    writeFileSync(join(paths.logsDir, 'loop.log'), 'legacy output\n')
    writeFileSync(join(paths.queueDir, 'run-branch.txt'), 'feature/previous-run\n')

    prepareLoopLog(paths, {
      now: new Date(2026, 7, 9, 18, 59, 36),
      runBranch: 'feature/current-run',
    })

    expect(readFileSync(
      join(paths.logsDir, 'loop-feature-previous-run-20260809_185936.log'),
      'utf8',
    )).toBe('legacy output\n')
    expect(readFileSync(join(paths.logsDir, 'loop.log.branch'), 'utf8'))
      .toBe('feature/current-run\n')
  })
})

describe('loopLogLines', () => {
  it('prefixes every physical line with a local date and time', () => {
    const now = new Date(2026, 7, 10, 1, 2, 3)

    expect(loopLogLines('[loop] WARN: git failed\nraw stderr\n', now)).toEqual([
      '[loop] 2026-08-10 01:02:03 WARN: git failed',
      '[loop] 2026-08-10 01:02:03 raw stderr',
      '[loop] 2026-08-10 01:02:03 ',
    ])
  })

  it('uses the timestamp prefix shape required by loop.log consumers', () => {
    expect(loopLogLines('CYCLE_COMPLETE: 1/2')[0])
      .toMatch(/^\[loop\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} CYCLE_COMPLETE: 1\/2$/)
  })

  it('caps an over-length message at 79 characters plus an ellipsis', () => {
    const content = 'a'.repeat(81)

    const line = loopLogLines(content, new Date(2026, 7, 10, 1, 2, 3))[0]!

    expect(line).toBe(`[loop] 2026-08-10 01:02:03 ${'a'.repeat(79)}…`)
    expect(line.slice('[loop] 2026-08-10 01:02:03 '.length)).toHaveLength(80)
  })

  it.each([79, 80])('leaves a %i-character message unchanged', (length) => {
    const content = 'a'.repeat(length)

    expect(loopLogLines(content, new Date(2026, 7, 10, 1, 2, 3)))
      .toEqual([`[loop] 2026-08-10 01:02:03 ${content}`])
  })

  it('caps each line of a multiline message independently', () => {
    expect(loopLogLines(
      `${'a'.repeat(81)}\n${'b'.repeat(80)}\n${'c'.repeat(100)}`,
      new Date(2026, 7, 10, 1, 2, 3),
    )).toEqual([
      `[loop] 2026-08-10 01:02:03 ${'a'.repeat(79)}…`,
      `[loop] 2026-08-10 01:02:03 ${'b'.repeat(80)}`,
      `[loop] 2026-08-10 01:02:03 ${'c'.repeat(79)}…`,
    ])
  })
})
