import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { classifyManagedCustomerOrigin, environmentSessionCookieNames, managedTenantUrls } from '../src/tenantEnvironmentHostnames.js'

const environments = ['live','uat','test']
const expected = {live:'acme', uat:'acmeuat', test:'acmetest'}

test('managed environments resolve independent per-customer application/portal/RMM origins', () => {
  for (const env of environments) {
    const urls = managedTenantUrls('acme','hi5central.com',env,{rmm:true})
    assert.deepEqual(urls, {
      tenantUrl: `https://${expected[env]}.hi5central.com`,
      portalUrl: `https://${expected[env]}-portal.hi5central.com`,
      rmmUrl: `https://${expected[env]}-rmm.hi5central.com`,
    })
    for (const [key, product] of [['tenantUrl','workspace'],['portalUrl','portal'],['rmmUrl','rmm']]) {
      assert.deepEqual(classifyManagedCustomerOrigin(urls[key]),{tenantSlug:'acme',environment:env,product})
    }
  }
})

test('invalid, ambiguous and unrelated origins fail closed', () => {
  for (const origin of [
    'https://admin.hi5central.com','https://dev.hi5central.com',
    'https://acme.other.com','http://acmeuat.hi5central.com',
    'https://acmeuat.hi5central.com:444',
    'https://acmeuat.hi5central.com/login',
    'https://acmeuat.hi5central.com.evil.com',
    'https://otheruat.hi5central.com@evil.com',
  ]) assert.equal(classifyManagedCustomerOrigin(origin),null,origin)
})

test('separate API session names per managed environment, retain legacy live and Dev', () => {
  const values = environments.map(runtimeEnvironment=>environmentSessionCookieNames({runtimeEnvironment,deploymentMode:'managed',tenancyMode:'multi'}))
  assert.deepEqual(values.map(x=>x.workspace),['hi5central_session','hi5central_uat_session','hi5central_test_session'])
  assert.equal(new Set(values.map(x=>x.workspace)).size,3)
  assert.equal(environmentSessionCookieNames({runtimeEnvironment:'dev',deploymentMode:'managed',tenancyMode:'single'}).workspace,'hi5central_dev_session')
})

function runtimeCheck(environment, extraEnv = {}) {
  const script = `
    import { tenantUrls, allowedRequestOrigin, originMatchesTenant, originMatchesPortalTenant, deployment } from ${JSON.stringify(new URL('../src/deploymentConfig.js',import.meta.url).href)};
    const cases = ['https://acme.hi5central.com','https://acmeuat.hi5central.com','https://acmetest.hi5central.com',
      'https://acmeuat-rmm.hi5central.com','https://acmeuat-portal.hi5central.com',
      'https://acmetest-portal.hi5central.com','https://otheruat.hi5central.com',
      'https://hi5central.com','https://admin.hi5central.com'];
    console.log(JSON.stringify({
      urls:tenantUrls('acme',{rmm:true}),cookieDomain:deployment.cookieDomain,
      cases:cases.map(origin=>({origin,allowed:Boolean(allowedRequestOrigin(origin)),sameTenant:originMatchesTenant(origin,'acme'),
        portal:originMatchesPortalTenant(origin,origin+'/portal','acme')}))
    }));
  `
  return spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',RUNTIME_ENVIRONMENT:environment,
      ROOT_DOMAIN:'hi5central.com',APP_URL:'',API_URL:'',PORTAL_URL:'',ADMIN_URL:'',COOKIE_DOMAIN:'',...extraEnv},
    encoding:'utf8',
  })
}

test('each managed sandbox accepts only origins from its own environment', () => {
  for (const environment of ['uat','test']) {
    const result=runtimeCheck(environment)
    assert.equal(result.status,0,result.stderr)
    const output=JSON.parse(result.stdout.trim())
    assert.equal(output.cookieDomain,'')
    assert.equal(output.urls.tenantUrl,`https://${expected[environment]}.hi5central.com`)
    for (const item of output.cases) {
      const own = classifyManagedCustomerOrigin(item.origin)?.environment===environment
      assert.equal(item.allowed,Boolean(own),item.origin)
      assert.equal(item.sameTenant,Boolean(own && item.origin !== 'https://otheruat.hi5central.com'),item.origin)
    }
  }
})

test('managed sandbox rejects explicit cross-subdomain cookie settings', () => {
  const result=runtimeCheck('uat',{COOKIE_DOMAIN:'.hi5central.com'})
  assert.notEqual(result.status,0)
  assert.match(result.stderr,/host-only API session cookies/)
})

test('managed Production preserves legacy tenant URLs and session rules', () => {
  const result=runtimeCheck('live')
  assert.equal(result.status,0,result.stderr)
  const output=JSON.parse(result.stdout.trim())
  assert.equal(output.urls.tenantUrl,'https://acme.hi5central.com')
  assert.equal(output.cookieDomain,'.hi5central.com')
})

test('single-tenant Dev origin and existing URLs remain intact', () => {
  const result=runtimeCheck('dev',{TENANCY_MODE:'single',APP_URL:'https://dev.hi5central.com',API_URL:'https://dev-api.hi5central.com'})
  assert.equal(result.status,0,result.stderr)
  const output=JSON.parse(result.stdout.trim())
  assert.equal(output.urls.tenantUrl,'https://dev.hi5central.com')
  assert.equal(output.cookieDomain,'')
})
