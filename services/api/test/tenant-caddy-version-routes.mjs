import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareTenantCaddyRoute,undoTenantCaddyRoute} from '../src/tenantCaddyVersionRoutes.js'
const before='http://test.hi5central.com {\n  @platformApi path /api/*\n  handle @platformApi {\n    reverse_proxy control-server:3001\n  }\n  handle {\n    reverse_proxy itsm-web:80\n  }\n}\n'
const sha1='a'.repeat(40),sha2='b'.repeat(40)
test('Different Test customers independently route to distinct immutable release pools',()=>{
  const a=prepareTenantCaddyRoute({config:before,tenantSlug:'acme',environment:'test',buildSha:sha1})
  const b=prepareTenantCaddyRoute({config:a.config,tenantSlug:'other',environment:'test',buildSha:sha2})
  assert.match(b.config,/X-Forwarded-Host acme-test[.]hi5central[.]com/)
  assert.match(b.config,/X-Forwarded-Host other-test[.]hi5central[.]com/)
  assert.match(b.config,/hi5pool-test-aaaaaaaaaaaa-api/)
  assert.match(b.config,/hi5pool-test-bbbbbbbbbbbb-api/)
  const reverted=undoTenantCaddyRoute({current:b.config,original:a.config,host:'other-test.hi5central.com'})
  assert.equal(reverted,a.config)
})
test('Upgrade one tenant without modifying the other and scoped rollback restores previous build',()=>{
  const a=prepareTenantCaddyRoute({config:before,tenantSlug:'acme',environment:'test',buildSha:sha1})
  const b=prepareTenantCaddyRoute({config:a.config,tenantSlug:'other',environment:'test',buildSha:sha1})
  const upgraded=prepareTenantCaddyRoute({config:b.config,tenantSlug:'acme',environment:'test',buildSha:sha2})
  const restored=undoTenantCaddyRoute({current:upgraded.config,original:b.config,host:'acme-test.hi5central.com'})
  assert.equal(restored,b.config)
})
test('Custom UAT uses exact forwarded host, Production uses direct host',()=>{
  const uat=prepareTenantCaddyRoute({
    config:'http://uat.hi5central.com {\n  handle { reverse_proxy itsm-web:80 }\n}\n',
    tenantSlug:'customer',environment:'uat',buildSha:sha1,
  })
  assert.match(uat.config,/X-Forwarded-Host customer-uat[.]hi5central[.]com/)
  assert.doesNotMatch(uat.config,/h5c-managed-qa26/)
  const live=prepareTenantCaddyRoute({
    config:'*.hi5central.com {\n    # Isolated QA onboarding recovery frontend; other customers untouched.\n}\n',
    tenantSlug:'customer',environment:'live',buildSha:sha1,
  })
  assert.match(live.config,/@h5cRelease[a-f0-9]{12} host customer[.]hi5central[.]com/)
})
test('Reject unknown host, invalid release SHA, foreign snapshot or malformed route markers',()=>{
  assert.throws(()=>prepareTenantCaddyRoute({config:before,tenantSlug:'a.dev',environment:'test',buildSha:sha1}))
  assert.throws(()=>prepareTenantCaddyRoute({config:before,tenantSlug:'acme',environment:'live',buildSha:sha1}))
  assert.throws(()=>prepareTenantCaddyRoute({config:before,tenantSlug:'acme',environment:'test',buildSha:'latest'}))
  const a=prepareTenantCaddyRoute({config:before,tenantSlug:'acme',environment:'test',buildSha:sha1})
  assert.throws(()=>undoTenantCaddyRoute({current:a.config,original:before,host:'other-test.hi5central.com'}))
})
