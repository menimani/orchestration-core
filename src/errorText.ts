// Every failure the loop reports has to survive a log line: one line, aligned, capped.
// Two shapes of reduction cover that, and which one fits depends on where the detail is.
// A failed child process says little in its Error message and everything in its stderr,
// so a command failure keeps the stderr and flattens the newlines out of it; an Error
// raised in this process already carries its detail in the first line of the message,
// with a stack or an appended cause behind it that a log line has no room for.
//
// Between them the two shapes had been copied into seven files, which is how a fix to
// one of them could miss the other six. src/loop.ts keeps a third reduction of its own
// on purpose: it preserves the whole message, newlines included, because its callers
// pass that text to a gate report rather than to a single log line.

/**
 * Summarize a failed command, preferring its stderr over the thrown message and
 * collapsing the whitespace so the result fits one line.
 */
export function commandFailureSummary(error: unknown): string {
  const failure = error as { stderr?: string | Buffer }
  const stderr = Buffer.isBuffer(failure.stderr)
    ? failure.stderr.toString('utf8')
    : failure.stderr
  return (stderr?.trim() || (error instanceof Error ? error.message : String(error)))
    .replaceAll(/\s+/g, ' ')
}

/**
 * The first line of an error's message, which is the part that names the failure.
 * An error carrying no message at all still has to report something.
 */
export function errorHeadline(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split(/\r?\n/, 1)[0] ?? '').trim() || 'unknown error'
}
