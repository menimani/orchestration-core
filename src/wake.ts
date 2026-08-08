import { watch, type FSWatcher } from 'node:fs'
import type { OrchPaths } from './paths.ts'

const WAKE_DEBOUNCE_MS = 500

export function waitForNextPoll(paths: OrchPaths, seconds: number): Promise<'timeout' | 'woken'> {
  return new Promise((resolve) => {
    let watcher: FSWatcher | undefined
    let debounce: NodeJS.Timeout | undefined
    let settled = false

    const disposeWatcher = (): void => {
      if (debounce !== undefined) clearTimeout(debounce)
      debounce = undefined
      watcher?.close()
      watcher = undefined
    }
    const timeout = setTimeout(() => finish('timeout'), seconds * 1000)
    const finish = (outcome: 'timeout' | 'woken'): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      disposeWatcher()
      resolve(outcome)
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
}
