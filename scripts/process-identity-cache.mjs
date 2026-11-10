import { performance } from 'node:perf_hooks'

const identityReuseMilliseconds = 5_000

// Wraps a process-identity probe so a lock waiter does not start one on every retry.
// Entries are keyed by PID and remember the identity the caller recorded for it. A probe
// that answers a different identity is final for that record: the recorded process can
// never return to that PID. A matching or unavailable answer is reused for five seconds.
// Callers still check liveness on every retry, so a dead PID is noticed without a probe.
export function createProcessIdentityCache(probe, now = () => performance.now()) {
  const entries = new Map()
  return (pid, recordedIdentity) => {
    const entry = entries.get(pid)
    if (entry !== undefined && entry.recordedIdentity === recordedIdentity) {
      const mismatched = entry.identity !== null && entry.identity !== recordedIdentity
      if (mismatched || now() - entry.probedAt < identityReuseMilliseconds) return entry.identity
    }
    const identity = probe(pid)
    entries.set(pid, { recordedIdentity, identity, probedAt: now() })
    return identity
  }
}
