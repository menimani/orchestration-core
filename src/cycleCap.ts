import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { errorHeadline } from './errorText.ts'

/** Persists a live MAX_SCAN_CYCLES change once the daemon owns the cap file. */
export interface CycleCapRecorder {
  /** Receives every MAX_SCAN_CYCLES read, with the value the reader is given. */
  observe: (cap: number) => void
}

export interface CycleCapRecorderOptions {
  /** The cap already in the file. */
  persisted: number
  /** The file as a log line names it. */
  label: string
  /** False once a replacement daemon owns the file. */
  owns: () => boolean
  warn: (detail: string) => void
}

/**
 * The file is advisory — only `shipped` reads it — and a read reaches the recorder from
 * whichever statement asked for the cap, so a failed write is reported, never thrown. The
 * persisted cap advances only when a write succeeds, so the next read tries again; a
 * write that keeps failing warns once per cap.
 */
export function createCycleCapRecorder(
  file: string,
  options: CycleCapRecorderOptions,
): CycleCapRecorder {
  let persisted = options.persisted
  let warned: number | undefined
  return {
    observe(cap) {
      if (Object.is(cap, persisted) || !options.owns()) return
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, `${cap}\n`, { flag: 'wx' })
        renameSync(temporary, file)
        persisted = cap
        warned = undefined
      } catch (error) {
        try {
          rmSync(temporary, { force: true })
        } catch {
          // The write already failed; that failure is the one worth reporting.
        }
        if (!Object.is(warned, cap)) {
          warned = cap
          options.warn(`could not write ${options.label}: ${errorHeadline(error)}`)
        }
      }
    },
  }
}
