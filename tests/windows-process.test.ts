import { describe, expect, it } from 'vitest'
import {
  processTreeRootPid, quoteWindowsArgument, WINDOWS_PROCESS_ROOT_PID_ENV,
} from '../src/adapters/windows-process.ts'

// These are pure functions describing Windows conventions, so every platform runs them.
// The process-launching assertions that only Windows can make live in
// windows-console.test.ts, which vitest.config.ts collects on Windows alone.

describe('Windows process arguments', () => {
  it('quotes arguments according to the Windows argv parsing rules', () => {
    expect(quoteWindowsArgument('plain')).toBe('plain')
    expect(quoteWindowsArgument('')).toBe('""')
    expect(quoteWindowsArgument('two words')).toBe('"two words"')
    expect(quoteWindowsArgument('C:\\path with space\\')).toBe('"C:\\path with space\\\\"')
    expect(quoteWindowsArgument('say "hello"')).toBe('"say \\"hello\\""')
  })

  it('uses the wrapper PID only when it is a valid positive integer', () => {
    expect(processTreeRootPid({ [WINDOWS_PROCESS_ROOT_PID_ENV]: '43210' })).toBe(43210)
    expect(processTreeRootPid({ [WINDOWS_PROCESS_ROOT_PID_ENV]: '0' })).toBe(process.pid)
    expect(processTreeRootPid({ [WINDOWS_PROCESS_ROOT_PID_ENV]: 'not-a-pid' }))
      .toBe(process.pid)
  })
})
