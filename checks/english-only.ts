// Verifies that the core's own sources are written in English, by reporting characters
// outside ASCII that are not on the list of ones English legitimately uses.
//
// Looking for a particular language misses full-width punctuation, zero-width spaces,
// and scripts outside the selected ranges. Starting from "not ASCII" and subtracting
// what English needs catches all of them.
//
// Run from the repository root: node checks/english-only.ts
import { readdirSync, readFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')

// Letters English borrows for proper nouns, such as Sao Paulo with a tilde or cafe with
// an acute accent. The script property admits no CJK, Cyrillic, or Greek letters.
const LATIN_LETTER = /\p{Script=Latin}/u
const COMBINING_DIACRITICS = /[̀-ͯ]/

// Typography and symbols the core's sources use. Each is explicit so adding a new
// non-ASCII character remains a decision instead of silently widening the rule.
const PUNCTUATION: ReadonlySet<string> = new Set([
  '—', '…',
  '→', '←',
  '─', '│', '├', '└',
])

// Emoji carry no language. Variation selectors are included because they form part of
// the displayed glyph rather than independent text.
const PICTOGRAPH = /[🌀-🫿️]/u

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.cjs', '.css', '.cts', '.html', '.js', '.json', '.md', '.mjs', '.mts',
  '.properties', '.sh', '.snap', '.sql', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
])
const SOURCE_NAMES: ReadonlySet<string> = new Set([
  '.gitattributes', '.gitignore', 'LICENSE', 'commit-msg', 'pre-commit',
])
const GENERATED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git', 'build', 'coverage', 'dist', 'node_modules',
])
const RUNTIME_DIRECTORIES: ReadonlySet<string> = new Set([
  'orchestration/logs',
  'orchestration/queue',
  'orchestration/status',
  'orchestration/tasks',
  'orchestration/worktrees',
])

// This test proves that the runner transports a multi-byte specification without putting
// it in the command line. Its Japanese payload is test data, not repository prose.
const ALLOWED_PATHS: ReadonlySet<string> = new Set(['tests/runner-codex.test.ts'])

const permitted = (character: string): boolean =>
  character.codePointAt(0)! < 128
  || PUNCTUATION.has(character)
  || LATIN_LETTER.test(character)
  || COMBINING_DIACRITICS.test(character)
  || PICTOGRAPH.test(character)

const normalizedPath = (file: string): string => file.replaceAll('\\', '/')

const repositoryRelativePath = (file: string): string => normalizedPath(relative(
  PACKAGE_ROOT,
  isAbsolute(file) ? file : resolve(PACKAGE_ROOT, file),
))

const isGeneratedDirectory = (directory: string): boolean => {
  const repositoryPath = repositoryRelativePath(directory)
  return GENERATED_DIRECTORY_NAMES.has(repositoryPath.split('/').at(-1) ?? '')
    || RUNTIME_DIRECTORIES.has(repositoryPath)
}

/** Whether a source path is intentionally excluded from the core language check. */
export const isEnglishAllowedPath = (file: string): boolean =>
  ALLOWED_PATHS.has(repositoryRelativePath(file))

export type TextViolation = {
  line: number
  codePoints: string[]
  text: string
}

/** Finds the non-English characters on each violating line of source text. */
export const scanText = (content: string): TextViolation[] =>
  content.split('\n').flatMap((line, index) => {
    const offenders = [...new Set([...line].filter((character) => !permitted(character)))]
    if (offenders.length === 0) return []
    return [{
      line: index + 1,
      codePoints: offenders.map((character) =>
        `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`),
      text: line.trim().slice(0, 76),
    }]
  })

const isSource = (file: string): boolean => {
  const name = file.split(/[\\/]/).at(-1) ?? ''
  return SOURCE_NAMES.has(name) || SOURCE_EXTENSIONS.has(extname(name))
}

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) return isGeneratedDirectory(fullPath) ? [] : walk(fullPath)
    return entry.isFile() && isSource(entry.name) ? [fullPath] : []
  })

export const main = (): number => {
  let hits = 0

  for (const file of walk(PACKAGE_ROOT)) {
    if (isEnglishAllowedPath(file)) continue
    for (const violation of scanText(readFileSync(file, 'utf8'))) {
      // Name the code points because some offenders, such as zero-width spaces, are
      // invisible in the report too.
      console.log(`${repositoryRelativePath(file)}:${violation.line}: ${violation.codePoints.join(' ')}`)
      console.log(`    ${violation.text}`)
      hits++
    }
  }

  console.log(hits === 0 ? 'All core sources are English.' : `${hits} lines`)
  return hits === 0 ? 0 : 1
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
