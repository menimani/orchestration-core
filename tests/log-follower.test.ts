import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { followLog } from '../src/logFollower.ts'

let directory: string | undefined

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function tempLog(contents: string): string {
  directory = mkdtempSync(join(tmpdir(), 'orch-log-follower-'))
  const file = join(directory, 'task.log')
  writeFileSync(file, contents)
  return file
}

function collectingOutput(onText?: (text: string) => void): { output: Writable, read: () => string } {
  let text = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      onText?.(text)
      callback()
    },
  })
  return { output, read: () => text }
}

describe('log follower', () => {
  it('prints the last ten lines and follows appended bytes', async () => {
    const file = tempLog(Array.from({ length: 12 }, (_, index) => `line ${index + 1}\n`).join(''))
    const controller = new AbortController()
    let initialWritten: () => void
    const initialOutput = new Promise<void>((resolve) => { initialWritten = resolve })
    const collected = collectingOutput((text) => {
      if (text.includes('line 12\n')) initialWritten()
      if (text.includes('appended\n')) controller.abort()
    })

    const following = followLog(file, collected.output, {
      signal: controller.signal,
      pollIntervalMs: 5,
    })
    await initialOutput
    appendFileSync(file, 'appended\n')
    await following

    expect(collected.read()).toBe(
      `${Array.from({ length: 10 }, (_, index) => `line ${index + 3}\n`).join('')}appended\n`,
    )
  })

  it('starts at the beginning after the log is replaced', async () => {
    const file = tempLog('old\n')
    const controller = new AbortController()
    let initialWritten: () => void
    const initialOutput = new Promise<void>((resolve) => { initialWritten = resolve })
    const collected = collectingOutput((text) => {
      if (text.includes('old\n')) initialWritten()
      if (text.includes('new\n')) controller.abort()
    })

    const following = followLog(file, collected.output, {
      signal: controller.signal,
      pollIntervalMs: 5,
    })
    await initialOutput
    renameSync(file, `${file}.old`)
    writeFileSync(file, 'new\n')
    await following

    expect(collected.read()).toBe('old\nnew\n')
  })

  it('rejects when the followed path is not a file', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orch-log-follower-'))
    await expect(followLog(directory, new Writable({ write(_chunk, _encoding, callback) {
      callback()
    } }))).rejects.toThrow(`Cannot follow a non-file: ${directory}`)
  })

  it('rejects output errors', async () => {
    const file = tempLog('log text\n')
    const error = new Error('output failed')
    const output = new Writable({ write(_chunk, _encoding, callback) {
      callback(error)
    } })

    await expect(followLog(file, output)).rejects.toThrow('output failed')
  })
})
