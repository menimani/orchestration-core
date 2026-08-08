import { watch, type FSWatcher } from 'node:fs'
import type { OrchPaths } from './paths.ts'

const WAKE_DEBOUNCE_MS = 500

export type WakeOutcome = 'timeout' | 'woken' | 'cancelled'

export interface NextPollObservation {
  outcome: Promise<WakeOutcome>
  cancel: () => void
}

/** Start observing before a poll so an enqueue at the poll/sleep boundary is retained. */
export function observeNextPoll(paths: OrchPaths, seconds: number): NextPollObservation {
  let watcher: FSWatcher | undefined
  let debounce: NodeJS.Timeout | undefined
  let settled = false
  let finish: (outcome: WakeOutcome) => void = () => {}

  const outcome = new Promise<WakeOutcome>((resolve) => {
    const disposeWatcher = (): void => {
      if (debounce !== undefined) clearTimeout(debounce)
      debounce = undefined
      watcher?.close()
      watcher = undefined
    }
    const timeout = setTimeout(() => finish('timeout'), seconds * 1000)
    finish = (result): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      disposeWatcher()
      resolve(result)
    }

    try {
      watcher = watch(paths.queueDir, (_eventType, filename) => {
        if (filename !== 'backlog.txt') return
        if (debounce !== undefined) clearTimeout(debounce)
        debounce = setTimeout(() => finish('woken'), WAKE_DEBOUNCE_MS)
      })
      watcher.on('error', disposeWatcher)
    } catch {
      disposeWatcher()
    }
  })

  return { outcome, cancel: () => finish('cancelled') }
}
