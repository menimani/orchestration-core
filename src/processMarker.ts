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

/** Parse an identity-bearing marker written by current versions. */
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

function legacyProcessMarkerPid(text: string): number | undefined {
  const value = text.trim()
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const pid = Number(value)
  return Number.isSafeInteger(pid) ? pid : undefined
}

/**
 * Return the live owner described by current or legacy marker text. Legacy bare PIDs
 * cannot distinguish reuse, but while that PID is live an upgrade must preserve the
 * old daemon's reservation instead of risking two loops in one repository.
 */
export function currentProcessMarkerPid(text: string): number | undefined {
  const marker = parseProcessMarker(text)
  if (marker !== undefined) return processMarkerIsCurrent(marker) ? marker.pid : undefined
  const pid = legacyProcessMarkerPid(text)
  if (pid === undefined) return undefined
  try {
    return operatingSystem.processIsAlive(pid) ? pid : undefined
  } catch {
    // An unavailable liveness probe does not prove that the legacy owner stopped.
    return pid
  }
}
