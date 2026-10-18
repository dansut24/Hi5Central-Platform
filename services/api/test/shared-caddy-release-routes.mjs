import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareSharedTenantCaddyRoute} from '../src/tenantCaddyVersionRoutes.js'
const sha='a'.repeat(40)
const base=`*.hi5central.com, hi5central.com {
  @apiHost host api.hi5central.com
  handle @apiHost { reverse_proxy api:3001 }
  # H5C_RELEASE_ROUTE_INSERT
  handle { reverse_proxy itsm:80 }
}`
test('Shared wildcard Caddy supports managed live, custom UAT and Test with exact routes',()=>{
 let config=base
 for(const [stage,slug] of [['live','managed-customer'],['uat','custom-customer'],['test','managed-customer']]){
  const r=prepareSharedTenantCaddyRoute({config,tenantSlug:slug,environment:stage,buildSha:sha})
  assert.match(r.config,new RegExp(r.host.replaceAll('.','\\.')))
  assert.match(r.config,new RegExp('hi5pool-'+stage+'-aaaaaaaaaaaa-api:3001'))
  config=r.config
 }
 assert.match(config,/reverse_proxy api:3001/)
 assert.match(config,/reverse_proxy itsm:80/)
 assert.equal((config.match(/H5C_RELEASE_ROUTE_BEGIN/g)||[]).length,3)
 const update=prepareSharedTenantCaddyRoute({config,tenantSlug:'managed-customer',environment:'live',buildSha:'b'.repeat(40)})
 assert.equal((update.config.match(/H5C_RELEASE_ROUTE_BEGIN/g)||[]).length,3)
 assert.match(update.config,/hi5pool-live-bbbbbbbbbbbb-web:80/)
 assert.match(update.config,/hi5pool-uat-aaaaaaaaaaaa-web:80/)
})
test('No shared anchor or malformed tenant is a hard stop',()=>{
 assert.throws(()=>prepareSharedTenantCaddyRoute({config:'no marker',tenantSlug:'good',environment:'live',buildSha:sha}))
 assert.throws(()=>prepareSharedTenantCaddyRoute({config:base,tenantSlug:'../../oops',environment:'live',buildSha:sha}))
})
