import { operatingSystem } from './adapters/os.ts'
import { lockOwnerIsCurrent } from './processOwner.ts'

export interface ProcessMarker {
  pid: number
  startIdentity: string
}

/** Record enough process identity to distinguish a live owner from a reused PID. */
export function processMarker(pid: number): ProcessMarker {
  let startIdentity: string | undefined
  try {
    startIdentity = operatingSystem.processStartIdentity(pid)
  } catch {
    startIdentity = undefined
  }
  if (startIdentity === undefined || startIdentity === '') {
    throw new Error(`Could not determine process-start identity for PID ${pid}`)
  }
  return { pid, startIdentity }
}

export function processMarkerText(marker: ProcessMarker): string {
  return `${JSON.stringify(marker)}\n`
}

/** Bare-PID and malformed legacy markers are intentionally unverifiable. */
export function parseProcessMarker(text: string): ProcessMarker | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<ProcessMarker>
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0
      || typeof parsed.startIdentity !== 'string' || parsed.startIdentity === '') {
      return undefined
    }
    return parsed as ProcessMarker
  } catch {
    return undefined
  }
}

export function processMarkerIsCurrent(marker: ProcessMarker): boolean {
  return lockOwnerIsCurrent(marker.pid, marker.startIdentity)
}
