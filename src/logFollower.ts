import { open, readFile, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Writable } from 'node:stream'

interface FollowLogOptions {
  signal?: AbortSignal
  pollIntervalMs?: number
}

function lastLines(contents: Buffer, count: number): Buffer {
  let separators = 0
  let index = contents.length - 1
  if (contents[index] === 0x0a) index--
  for (; index >= 0; index--) {
    if (contents[index] === 0x0a && ++separators === count) {
      return contents.subarray(index + 1)
    }
  }
  return contents
}

async function write(output: Writable, contents: Buffer): Promise<void> {
  if (contents.length === 0) return
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    output.once('error', onError)
    output.write(contents, (error?: Error | null) => {
      if (error !== undefined && error !== null) return
      output.off('error', onError)
      resolve()
    })
  })
}

/** Print the end of a log and continue printing bytes appended to it. */
export async function followLog(
  file: string,
  output: Writable,
  options: FollowLogOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 250
  let position = 0n
  let identity: string | undefined
  let initial = true

  while (!options.signal?.aborted) {
    const fileStat = await stat(file, { bigint: true })
    if (!fileStat.isFile()) throw new Error(`Cannot follow a non-file: ${file}`)

    const currentIdentity = `${fileStat.dev}:${fileStat.ino}`
    if (identity !== undefined && (identity !== currentIdentity || fileStat.size < position)) {
      position = 0n
    }
    identity = currentIdentity

    if (initial) {
      const contents = await readFile(file)
      await write(output, lastLines(contents, 10))
      position = BigInt(contents.length)
      initial = false
    } else if (fileStat.size > position) {
      const length = Number(fileStat.size - position)
      const contents = Buffer.allocUnsafe(length)
      const handle = await open(file, 'r')
      try {
        const { bytesRead } = await handle.read(contents, 0, length, Number(position))
        await write(output, contents.subarray(0, bytesRead))
        position += BigInt(bytesRead)
      } finally {
        await handle.close()
      }
    }

    try {
      await delay(pollIntervalMs, undefined, { signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted) return
      throw error
    }
  }
}
