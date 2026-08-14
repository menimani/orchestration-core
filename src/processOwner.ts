import { operatingSystem } from './adapters/os.ts'

/** Capture the identity of this particular use of the current process ID. */
export function currentProcessStartIdentity(): string | null {
  try {
    return operatingSystem.processStartIdentity(process.pid) ?? null
  } catch {
    return null
  }
}

/** Encode an identity for whitespace-delimited lock metadata. */
export function encodeProcessStartIdentity(startIdentity: string | null): string {
  return startIdentity === null ? '-' : Buffer.from(startIdentity).toString('base64url')
}

/** Decode a recorded identity, treating legacy or invalid metadata as unverifiable. */
export function decodeProcessStartIdentity(encoded: string | undefined): string | undefined {
  if (encoded === undefined || encoded === '-') return undefined
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString()
    return decoded === '' ? undefined : decoded
  } catch {
    return undefined
  }
}

/**
 * Whether the process described by lock metadata is still its owner. Legacy or
 * temporarily unverifiable metadata falls back to the conservative PID-only verdict.
 */
export function lockOwnerIsCurrent(pid: number, startIdentity?: string | null): boolean {
  if (typeof startIdentity === 'string') {
    let currentIdentity: string | undefined
    try {
      currentIdentity = operatingSystem.processStartIdentity(pid)
    } catch {
      currentIdentity = undefined
    }
    if (currentIdentity !== undefined) return currentIdentity === startIdentity
  }
  return operatingSystem.processIsAlive(pid)
}
