import { spawn, spawnSync } from 'node:child_process'

const image = 'node:24-bookworm'
const containerCommand = [
  'mkdir /workspace',
  'tar -xf - -C /workspace',
  'cd /workspace',
  'npm ci --no-audit --no-fund',
  'node checks/english-only.ts',
  'npm run typecheck',
  'npm test -- --pool=threads',
].join(' && ')

// A tag already present locally is never refreshed by `docker run`, so the default pulls
// on every run; without it the check keeps running whichever Node 24 patch was current
// when the image was first fetched, security releases included. A merge gate may choose
// `missing` instead, so a registry outage does not fail merges once the image has been
// pulled. A merge check is one command string, run by cmd.exe on Windows and by sh
// elsewhere, with no portable way to set a variable, so the argument is read first; an
// empty variable counts as unset, as it does for the loop's own settings.
const pullPolicies = ['always', 'missing']
const pullArgument = '--pull='
let pullPolicy
let pullSource
for (const argument of process.argv.slice(2)) {
  if (!argument.startsWith(pullArgument)) {
    console.error(`Unknown argument '${argument}'; the only argument is ${pullArgument}<${pullPolicies.join('|')}>.`)
    process.exit(1)
  }
  pullPolicy = argument.slice(pullArgument.length)
  pullSource = '--pull'
}
if (pullPolicy === undefined && process.env.TEST_LINUX_PULL !== undefined && process.env.TEST_LINUX_PULL !== '') {
  pullPolicy = process.env.TEST_LINUX_PULL
  pullSource = 'TEST_LINUX_PULL'
}
pullPolicy ??= 'always'
if (!pullPolicies.includes(pullPolicy)) {
  console.error(`${pullSource} must be one of ${pullPolicies.join(', ')}; got '${pullPolicy}'.`)
  process.exit(1)
}

const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  encoding: 'utf8',
})
if (status.error !== undefined) throw status.error
if (status.status !== 0) process.exit(status.status ?? 1)
if (status.stdout.trim() !== '') {
  console.error('The Linux check exports HEAD; commit or stash working-tree changes first.')
  process.exit(1)
}

console.log(`Exporting HEAD and running verification in ${image} (image pull policy: ${pullPolicy})...`)

const archive = spawn('git', ['archive', '--format=tar', 'HEAD'], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
const docker = spawn('docker', [
  'run', '--rm', `--pull=${pullPolicy}`, '-i', image, 'sh', '-lc', containerCommand,
], {
  stdio: ['pipe', 'inherit', 'inherit'],
})

archive.stdout.pipe(docker.stdin)
archive.on('error', (error) => docker.stdin.destroy(error))
docker.on('error', (error) => archive.stdout.destroy(error))
// Docker can exit before it reads the archive, as it does when its engine is not
// running. Docker's own exit code is then the failure worth reporting, so the rest of
// the archive is drained to let git finish. pipe() leaves the archive paused when it
// detaches, and it detaches in either of two orders: a pending write fails with a broken
// pipe, or Node observes the exit first and destroys stdin without any error. Resuming
// on close covers both, because close follows the error too. Resuming only on the error
// left git blocked on a full pipe whenever the exit won, and the check never finished.
const brokenPipeCodes = new Set(['EPIPE', 'ECONNRESET'])
docker.stdin.on('error', (error) => {
  if (!brokenPipeCodes.has(error.code)) throw error
})
docker.stdin.on('close', () => archive.stdout.resume())

const archiveExit = new Promise((resolve) => archive.on('close', resolve))
const dockerExit = new Promise((resolve) => docker.on('close', resolve))
const [archiveCode, dockerCode] = await Promise.all([archiveExit, dockerExit])

if (archiveCode !== 0) {
  console.error(`git archive failed with exit code ${archiveCode}.`)
  process.exit(archiveCode ?? 1)
}
if (dockerCode !== 0) {
  console.error(`Linux verification failed with exit code ${dockerCode}.`)
  process.exit(dockerCode ?? 1)
}

console.log('Linux verification passed.')
