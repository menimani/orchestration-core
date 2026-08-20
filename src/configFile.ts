import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeConfigFile(filePath: string, values: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { flag: 'wx' })
    renameSync(temporary, filePath)
  } finally {
    rmSync(temporary, { force: true })
  }
}
