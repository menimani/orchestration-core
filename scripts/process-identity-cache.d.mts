export declare function createProcessIdentityCache(
  probe: (pid: number) => string | null,
  now?: () => number,
): (pid: number, recordedIdentity: string) => string | null
