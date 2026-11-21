import { readFileSync } from 'node:fs'

// Hand-written JSON on Windows often starts with a UTF-8 byte order mark: PowerShell 5.1
// writes one for `Set-Content -Encoding UTF8`, and so do some editors. readFileSync keeps
// it as U+FEFF, which JSON.parse rejects, so every file a person may edit is read here.

const BYTE_ORDER_MARK = 0xfeff

/** Parse JSON text read from a file, ignoring a leading byte order mark. */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text) as unknown
}

/** Read and parse a JSON file, ignoring a leading byte order mark. */
export function readJsonFile(file: string): unknown {
  return parseJsonText(readFileSync(file, 'utf8'))
}
