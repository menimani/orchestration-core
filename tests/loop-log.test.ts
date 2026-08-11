import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LoopWarningLog, loopLogLines, prepareLoopLog } from '../src/loopLog.ts'
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
  const now = new Date(2026, 7, 10, 1, 2, 3)
  const context = { currentCycle: 4, cycleCap: 12, now }

  it('prefixes every physical line with a local date and time', () => {
    expect(loopLogLines('WARN git failed\nraw stderr\n', context)).toEqual([
      '2026-08-10 01:02:03 [loop 04/12] WARN       git failed',
      '2026-08-10 01:02:03 [loop 04/12] WARN       raw stderr',
      '2026-08-10 01:02:03 [loop 04/12] WARN      ',
    ])
  })

  it('puts the timestamp first and zero-pads the cycle tag', () => {
    expect(loopLogLines('Started 030_scan    scan 1/4', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Started    030_scan    scan 1/4')

    expect(loopLogLines('WARN waiting', { ...context, currentCycle: 0 })[0])
      .toContain('[loop 00/12]')
  })

  it('uses the frozen single-word verb column', () => {
    expect(loopLogLines('Failed 031_auto    log 031_auto.log', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Failed     031_auto    log 031_auto.log')
  })

  it('keeps the frozen remote-wait and cycle-suite start lines', () => {
    expect(loopLogLines('Waiting remote  issues #349 #351', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Waiting    remote  issues #349 #351')
    expect(loopLogLines('Started Suite  cycle 6', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Started    Suite  cycle 6')
  })

  it('aligns the core update and restart transition', () => {
    expect(loopLogLines('Updated core        12345678..abcdef01', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Updated    core        12345678..abcdef01')
    expect(loopLogLines('Restarting core        for cycle 5', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Restarting core        for cycle 5')
  })

  it('aligns subjects for verbs of different lengths', () => {
    const scan = loopLogLines('Started 030_scan', context)[0]!
    const decision = loopLogLines('Decision choose a database', context)[0]!

    expect(scan.indexOf('030_scan')).toBe(decision.indexOf('choose a database'))
  })

  it('starts details at the same column for different subjects', () => {
    const scan = loopLogLines('Started 030_scan    scan 1/4', context)[0]!
    const review = loopLogLines('Started 227_review  effort medium', context)[0]!

    expect(scan.indexOf('scan 1/4')).toBe(review.indexOf('effort medium'))
  })

  it('aligns the Status counter groups with the shared event column', () => {
    expect(loopLogLines('Status Scan=4', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Status     Scan=4')
    expect(loopLogLines('Status Running=8  Queue=0', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Status     Running=8  Queue=0')
    expect(loopLogLines('Status Scan=2  Running=3  Queue=1', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] Status     Scan=2  Running=3  Queue=1')
  })

  it('does not rewrite frozen automation markers as presentation events', () => {
    expect(loopLogLines('CYCLE_COMPLETE: 4/12 PR:https://example.test/pull/322', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] CYCLE_COMPLETE: 4/12 PR:https://example.test/pull/322')
    expect(loopLogLines('FAILED: 20260810_010203_031_auto — log: logs/task.log', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] FAILED:    20260810_010203_031_auto — log: logs/task.log')
    expect(loopLogLines('LOOP_DONE: https://example.test/pull/322', context)[0])
      .toBe('2026-08-10 01:02:03 [loop 04/12] LOOP_DONE: https://example.test/pull/322')
  })

  it('caps an over-length message at 79 characters plus an ellipsis', () => {
    const content = 'a'.repeat(81)

    const line = loopLogLines(content, context)[0]!

    expect(line).toBe(`2026-08-10 01:02:03 [loop 04/12] ${'a'.repeat(79)}…`)
    expect(line.slice('2026-08-10 01:02:03 [loop 04/12] '.length)).toHaveLength(80)
  })

  it.each([79, 80])('leaves a %i-character message unchanged', (length) => {
    const content = 'a'.repeat(length)

    expect(loopLogLines(content, context))
      .toEqual([`2026-08-10 01:02:03 [loop 04/12] ${content}`])
  })

  it('caps each line of a multiline message independently', () => {
    expect(loopLogLines(
      `WARN ${'a'.repeat(81)}\n${'b'.repeat(80)}\n${'c'.repeat(100)}`,
      context,
    )).toEqual([
      `2026-08-10 01:02:03 [loop 04/12] WARN       ${'a'.repeat(68)}…`,
      `2026-08-10 01:02:03 [loop 04/12] WARN       ${'b'.repeat(68)}…`,
      `2026-08-10 01:02:03 [loop 04/12] WARN       ${'c'.repeat(68)}…`,
    ])
  })
})

describe('LoopWarningLog', () => {
  let now: Date
  let logged: string[]
  let warnings: LoopWarningLog

  beforeEach(() => {
    now = new Date(2026, 7, 10, 4, 57, 0)
    logged = []
    warnings = new LoopWarningLog(paths, (line) => logged.push(line), () => now)
  })

  it('collapses identical warnings and summarizes continued repetition after ten minutes', () => {
    const message = `forge unavailable: ${'connection refused '.repeat(6)}`

    warnings.warn('poll-forge', 'polling the forge', message)
    warnings.warn('poll-forge', 'polling the forge', message)
    now = new Date(2026, 7, 10, 5, 7, 0)
    warnings.warn('poll-forge', 'polling the forge', message)

    expect(logged).toHaveLength(2)
    expect(logged[0]).toBe(`WARN ${message}`)
    expect(logged[1]).toMatch(/^WARN forge unavailable: .*… repeated 2 times$/)
    expect(loopLogLines(logged[1]!, { currentCycle: 1, cycleCap: 12, now })[0])
      .toContain('repeated 2 times')
  })

  it('tracks interleaved warning call sites independently', () => {
    warnings.warn('poll-forge', 'polling the forge', 'forge unavailable')
    warnings.warn('heartbeat', 'sending a heartbeat', 'heartbeat unavailable')
    warnings.warn('poll-forge', 'polling the forge', 'forge unavailable')

    expect(logged).toEqual([
      'WARN forge unavailable',
      'WARN heartbeat unavailable',
    ])
  })

  it('announces recovery once with the warning duration', () => {
    warnings.warn('poll-forge', 'polling the forge', 'forge unavailable')
    now = new Date(2026, 7, 10, 5, 9, 59)

    warnings.recovered('poll-forge')
    warnings.recovered('poll-forge')

    expect(logged).toEqual([
      'WARN forge unavailable',
      'Recovered polling the forge after 12 minutes',
    ])
  })

  it('writes the first occurrence with full text to warn-detail.log', () => {
    const message = `forge unavailable: ${'detailed cause '.repeat(10)}`

    warnings.warn('poll-forge', 'polling the forge', message)
    warnings.warn('poll-forge', 'polling the forge', message)

    expect(readFileSync(join(paths.logsDir, 'warn-detail.log'), 'utf8'))
      .toBe(`2026-08-10 04:57:00 WARN ${message}\n`)
  })
})
