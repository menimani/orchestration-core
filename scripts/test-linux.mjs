import { spawn, spawnSync } from 'node:child_process'

const image = 'node:24-bookworm'
const containerCommand = [
  'mkdir /workspace',
  'tar -xf - -C /workspace',
  'cd /workspace',
  'npm ci --no-audit --no-fund',
  'node checks/english-only.ts',
  'npm run typecheck',
  'npm test -- --pool=threads --poolOptions.threads.singleThread',
].join(' && ')

const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  encoding: 'utf8',
})
if (status.error !== undefined) throw status.error
if (status.status !== 0) process.exit(status.status ?? 1)
if (status.stdout.trim() !== '') {
  console.error('The Linux check exports HEAD; commit or stash working-tree changes first.')
  process.exit(1)
}

console.log(`Exporting HEAD and running verification in ${image}...`)

const archive = spawn('git', ['archive', '--format=tar', 'HEAD'], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
const docker = spawn('docker', [
  'run', '--rm', '-i', image, 'sh', '-lc', containerCommand,
], {
  stdio: ['pipe', 'inherit', 'inherit'],
})

archive.stdout.pipe(docker.stdin)
archive.on('error', (error) => docker.stdin.destroy(error))
docker.on('error', (error) => archive.stdout.destroy(error))

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
