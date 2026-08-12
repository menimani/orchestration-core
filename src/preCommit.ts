import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectAdapter } from './adapters/project.ts'
import { currentRemoteDefaultBranch } from './gitRemote.ts'
import { execShellSync } from './shell.ts'

function stagedFiles(repoRoot: string): string[] {
  return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter((file) => file !== '')
}

function run(repoRoot: string, cwd: string, command: string): boolean {
  try {
    const output = execShellSync(command, {
      cwd: join(repoRoot, cwd),
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (output !== '') process.stdout.write(output)
    return true
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    if (failed.stdout !== undefined && failed.stdout !== '') process.stdout.write(failed.stdout)
    if (failed.stderr !== undefined && failed.stderr !== '') process.stderr.write(failed.stderr)
    return false
  }
}

function currentBranch(repoRoot: string): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function branchAcceptsCommits(repoRoot: string): boolean {
  const branch = currentBranch(repoRoot)
  if (branch === '') {
    console.log("OK: detached HEAD accepts commits because it is not a branch")
    return true
  }

  let defaultBranch: string
  let remote: string
  try {
    ({ branch: defaultBranch, remote } = currentRemoteDefaultBranch(repoRoot))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`NG: could not resolve the repository default branch: ${detail}`)
    return false
  }

  if (branch === defaultBranch) {
    console.error(
      `NG: commits to '${branch}' are prohibited; it is the default branch advertised by '${remote}'.`,
    )
    return false
  }
  console.log(`OK: branch '${branch}' accepts commits; '${remote}' advertises '${defaultBranch}'.`)
  return true
}

export function runPreCommitChecks(repoRoot: string, project: ProjectAdapter): boolean {
  const changed = stagedFiles(repoRoot)
  if (project.preCommitChecks.length === 0) {
    console.log('SKIP: project pre-commit checks; adapter declares none')
    return true
  }

  let ok = true
  for (const check of project.preCommitChecks) {
    if (check.appliesTo !== undefined && !check.appliesTo(changed)) {
      console.log(`SKIP: ${check.label}; staged paths do not apply`)
      continue
    }
    if (check.requires !== undefined && !existsSync(join(repoRoot, check.requires))) {
      console.log(`SKIP: ${check.label}; missing ${check.requires}`)
      continue
    }
    if (check.unless !== undefined && existsSync(join(repoRoot, check.unless))) {
      console.log(`SKIP: ${check.label}; ${check.unless} exists`)
      continue
    }
    const install = check.installWhenMissing
    if (install !== undefined && !existsSync(join(repoRoot, install.path))) {
      const installed = run(repoRoot, check.cwd, install.command)
      console.log(`${installed ? 'PASS' : 'FAIL'}: ${check.label} install`)
      ok = installed && ok
      if (!installed) continue
    }
    const passed = run(repoRoot, check.cwd, check.command)
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${check.label}`)
    ok = passed && ok
  }
  return ok
}
