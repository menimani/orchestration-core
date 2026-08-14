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
const GENERATED_DIRECTORY_PATTERNS: readonly RegExp[] = [
  /^\.node_modules\.previous-.+/,
  /^\.orchestration-npm-ci-.+/,
]
const RUNTIME_DIRECTORIES: ReadonlySet<string> = new Set([
  'orchestration/logs',
  'orchestration/queue',
  'orchestration/status',
  'orchestration/tasks',
  'orchestration/worktrees',
])

const permitted = (character: string): boolean =>
  character.codePointAt(0)! < 128
  || PUNCTUATION.has(character)
  || LATIN_LETTER.test(character)
  || COMBINING_DIACRITICS.test(character)

const normalizedPath = (file: string): string => file.replaceAll('\\', '/')

const repositoryRelativePath = (file: string, root = PACKAGE_ROOT): string => normalizedPath(relative(
  root,
  isAbsolute(file) ? file : resolve(root, file),
))

const isGeneratedDirectory = (directory: string, root: string): boolean => {
  const repositoryPath = repositoryRelativePath(directory, root)
  const name = repositoryPath.split('/').at(-1) ?? ''
  return GENERATED_DIRECTORY_NAMES.has(name)
    || GENERATED_DIRECTORY_PATTERNS.some((pattern) => pattern.test(name))
    || RUNTIME_DIRECTORIES.has(repositoryPath)
}

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

const walk = (directory: string, root: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) return isGeneratedDirectory(fullPath, root) ? [] : walk(fullPath, root)
    return entry.isFile() && isSource(entry.name) ? [fullPath] : []
  })

export const main = (root = PACKAGE_ROOT): number => {
  let hits = 0

  for (const file of walk(root, root)) {
    for (const violation of scanText(readFileSync(file, 'utf8'))) {
      // Name the code points because some offenders, such as zero-width spaces, are
      // invisible in the report too.
      console.log(`${repositoryRelativePath(file, root)}:${violation.line}: ${violation.codePoints.join(' ')}`)
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
