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

    // The token must appear in the run title for the deploy command's containment
    // matcher to find the exact run; the readable wrapper around it is free to change.
    expect(workflow).toMatch(/run-name: .*inputs\.dispatch_token/)
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

  it('keeps superseded deploys from moving production backwards', () => {
    const workflow = source('.github/workflows/deploy.yml')

    expect(workflow).toMatch(/concurrency:\n\s+group: deploy\n\s+cancel-in-progress: true/)
    expect(workflow).toMatch(/allow_rollback:\n(?:\s+.*\n)*?\s+default: false\n\s+type: boolean/)
    expect(workflow).toContain('if: ${{ !inputs.allow_rollback }}')
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" "$CURRENT_REVISION"')
  })

  it('notifies after both image building and deployment have finished', () => {
    const workflow = source('.github/workflows/deploy.yml')

    // The durable contract: a notification job that always runs after both jobs,
    // reports which outcome occurred, and sends from the server (the runner's foreign
    // IP is dropped by the mail provider's country filter before authentication).
    expect(workflow).toMatch(/notify:\n\s+name: Send the deployment notification\n(?:.*\n)*?\s+if: always\(\)/)
    expect(workflow).toContain('needs: [build-and-push, deploy]')
    expect(workflow).toMatch(/needs\.build-and-push\.result == 'success' && needs\.deploy\.result == 'success'/)
    expect(workflow).toContain('deploy/send-deploy-mail.sh')
    expect(source('deploy/send-deploy-mail.sh')).toContain('--mail-rcpt support@shiora.jp')
  })
})
