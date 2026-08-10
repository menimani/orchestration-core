import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..', '..', '..')

function source(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8')
}

describe('production deployment identity contract', () => {
  it('carries the dispatch token into the workflow run title', () => {
    const workflow = source('.github/workflows/deploy.yml')

    expect(workflow).toContain('run-name: ${{ inputs.dispatch_token }}')
    expect(workflow).toContain('dispatch_token:')
  })

  it('embeds and checks the exact workflow commit', () => {
    const workflow = source('.github/workflows/deploy.yml')
    const frontendDockerfile = source('src/frontend/Dockerfile')
    const backendDockerfile = source('src/backend/Dockerfile')

    expect(workflow).toContain('DEPLOY_COMMIT_SHA=${{ github.sha }}')
    expect(workflow).toContain('[ "$revision" = "${{ github.sha }}" ]')
    expect(frontendDockerfile).toContain('/.well-known/shiora-revision')
    expect(frontendDockerfile).toContain('org.opencontainers.image.revision=$DEPLOY_COMMIT_SHA')
    expect(backendDockerfile).toContain('org.opencontainers.image.revision=$DEPLOY_COMMIT_SHA')
  })

  it('notifies after both image building and deployment have finished', () => {
    const workflow = source('.github/workflows/deploy.yml')

    expect(workflow).toContain('notify:\n    name: Send the deployment notification\n    if: always()')
    expect(workflow).toContain('needs: [build-and-push, deploy]')
    expect(workflow).toContain("if: needs.build-and-push.result == 'success' && needs.deploy.result == 'success'")
    expect(workflow).toContain("if: needs.build-and-push.result != 'success' || needs.deploy.result != 'success'")
  })
})
