import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  isManagedCustomerSandbox,
  managedSandboxRequiresMfa,
  managedSandboxBlocksPublicSignup,
  managedSandboxBlocksRmm,
} from '../src/managedSandboxPolicy.js'

const sandbox = {
  deploymentMode: 'managed', tenancyMode: 'multi', runtimeEnvironment: 'uat',
}

test('managed UAT/Test block unsolicited signup and all RMM channels', () => {
  for (const runtimeEnvironment of ['uat', 'test']) {
    const config = { ...sandbox, runtimeEnvironment }
    assert.equal(isManagedCustomerSandbox(config), true)
    assert.equal(managedSandboxBlocksPublicSignup(config), true)
    assert.equal(managedSandboxRequiresMfa(config), true)
    assert.equal(managedSandboxBlocksRmm(config), true)
  }
})

test('internal Dev, Production and self-hosted editions retain their existing access paths', () => {
  for (const config of [
    { ...sandbox, runtimeEnvironment: 'dev', tenancyMode: 'single' },
    { ...sandbox, runtimeEnvironment: 'live' },
    { ...sandbox, tenancyMode: 'single' },
    { ...sandbox, deploymentMode: 'self_hosted' },
  ]) {
    assert.equal(isManagedCustomerSandbox(config), false)
    assert.equal(managedSandboxBlocksPublicSignup(config), false)
    assert.equal(managedSandboxRequiresMfa(config), false)
    assert.equal(managedSandboxBlocksRmm(config), false)
  }
})

function evaluateSecurityPolicy(runtimeEnvironment, tenancyMode = 'multi') {
  const uri = new URL('../src/securityPolicy.js', import.meta.url).href
  const script = `
    import { mfaRequiredFor, sessionNeedsMfa } from ${JSON.stringify(uri)};
    const user = { tenant_role: 'requester', onboarding_completed_at: null };
    const owner = { tenant_role: 'owner', onboarding_completed_at: null };
    const verified = { ...user, mfa_verified_at: new Date().toISOString() };
    console.log(JSON.stringify({
      user: mfaRequiredFor(user), owner: mfaRequiredFor(owner),
      deniedWithoutMfa: sessionNeedsMfa(user),
      grantedWithMfa: !sessionNeedsMfa(verified),
    }));
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env, DEPLOYMENT_MODE: 'managed', TENANCY_MODE: tenancyMode,
      RUNTIME_ENVIRONMENT: runtimeEnvironment, ROOT_DOMAIN: 'hi5central.com',
      COOKIE_DOMAIN: '',
    }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}

test('managed UAT/Test require MFA even before onboarding, for requesters and owners', () => {
  for (const environment of ['uat', 'test']) {
    assert.deepEqual(evaluateSecurityPolicy(environment), {
      user: true, owner: true, deniedWithoutMfa: true, grantedWithMfa: true,
    })
  }
})

test('Dev and legacy Production do not unexpectedly enforce pre-onboarding MFA', () => {
  for (const [environment, tenancyMode] of [['dev', 'single'], ['live', 'multi']]) {
    assert.deepEqual(evaluateSecurityPolicy(environment, tenancyMode), {
      user: false, owner: false, deniedWithoutMfa: false, grantedWithMfa: true,
    })
  }
})
