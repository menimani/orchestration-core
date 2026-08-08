import { describe, expect, it } from 'vitest'
import { shioraProject } from '../src/adapters/project-shiora.ts'

// The project adapter carries the repository's own knowledge: gate commands per
// TASK_GATE, and which touched paths make each check relevant.

function check(label: string, taskGate: 'full' | 'light' = 'full') {
  const found = shioraProject.mergeChecks(taskGate).find((entry) => entry.label === label)
  if (found === undefined) throw new Error(`no such check: ${label}`)
  return found
}

describe('gate commands', () => {
  it('declares the production deployment', () => {
    expect(shioraProject.deployment).toEqual({
      workflow: 'deploy.yml',
      url: 'https://shiora.jp',
    })
  })

  it('runs the full suites by default', () => {
    expect(check('Frontend gate', 'full').command).toBe('npm run test')
    expect(check('Backend gate', 'full').command).toBe('mvn clean test -q')
  })

  it('only builds and lints under the light gate', () => {
    expect(check('Frontend gate', 'light').command).toBe('npm run lint && npm run build')
    expect(check('Backend gate', 'light').command).toBe('mvn clean test-compile -q')
  })
})

describe('check selection', () => {
  it('selects suites from the touched paths', () => {
    expect(check('Frontend gate').appliesTo?.(['src/frontend/src/App.tsx'])).toBe(true)
    expect(check('Frontend gate').appliesTo?.(['src/backend/pom.xml'])).toBe(false)
    expect(check('Backend gate').appliesTo?.(['src/backend/pom.xml'])).toBe(true)
    expect(check('Orchestration gate').appliesTo?.(['orchestration/ts/src/cli.ts'])).toBe(true)
    expect(check('Frontend gate').appliesTo?.(['docs/index.html'])).toBe(false)
  })

  it('runs the i18n check for either side of the translation contract', () => {
    const i18n = check('Translation completeness')
    expect(i18n.appliesTo?.(['src/frontend/src/i18n/ja.json'])).toBe(true)
    expect(i18n.appliesTo?.(['src/backend/src/main/resources/messages.properties'])).toBe(true)
    expect(i18n.appliesTo?.(['src/backend/src/main/java/App.java'])).toBe(false)
  })

  it('runs the English check whatever changed', () => {
    expect(check('English only').appliesTo).toBeUndefined()
  })

  it('gates orchestration changes on the TS suite', () => {
    const orchestration = check('Orchestration gate')
    expect(orchestration.command).toBe(
      'npm ci --no-audit --no-fund && npm run typecheck && npm run test -- --pool=threads --poolOptions.threads.singleThread',
    )
    expect(orchestration.requires).toBe('orchestration/ts/package.json')
  })
})

describe('cycle suite', () => {
  it('lists the full suites with the vitest-launcher repair on the frontend step', () => {
    const steps = shioraProject.cycleSuite()
    expect(steps.map((step) => step.label)).toEqual([
      'Frontend suite', 'Backend suite', 'Translation completeness', 'English only',
    ])
    const frontend = steps[0]
    expect(frontend?.repairWhenMissing?.path).toBe('src/frontend/node_modules/.bin/vitest')
    expect(frontend?.repairWhenMissing?.command).toBe('npm install --no-audit --no-fund')
  })
})
