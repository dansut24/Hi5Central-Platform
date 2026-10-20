import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {prepareSharedTenantCaddyRoute} from '../src/tenantCaddyVersionRoutes.js'
import {assertTenantOnlyGatewayMutation} from '../src/stageRollbackExecution.mjs'

const beforeSha='96b9edbcf1631ce9719884c3e3f1700907a6eff0'
const restoreSha='d05e592ef6e43a494e685f77964b4f9a4eef2c30'
const config=':443 {\n  # H5C_RELEASE_ROUTE_INSERT\n}\n'
function fixture(stage='live'){
 const managed=prepareSharedTenantCaddyRoute({
  config,tenantSlug:'companymanaged',environment:'live',buildSha:beforeSha,
 })
 const custom=prepareSharedTenantCaddyRoute({
  config:managed.config,tenantSlug:'companycustom',environment:stage,buildSha:beforeSha,
 })
 const another=prepareSharedTenantCaddyRoute({
  config:custom.config,tenantSlug:'company',environment:'live',buildSha:beforeSha,
 })
 const host='companycustom'+(stage==='live'?'':'-uat')+'.hi5central.com'
 const after=prepareSharedTenantCaddyRoute({
  config:another.config,tenantSlug:'companycustom',environment:stage,buildSha:restoreSha,
 })
 return {before:another.config,after:after.config,host,tenantSlug:'companycustom',stage,buildSha:restoreSha}
}
for(const stage of ['live','uat']){
 test(stage+' permits host-verified rollback with route block relocated but no other changes',()=>{
  const input=fixture(stage)
  assert.equal(assertTenantOnlyGatewayMutation(input),true)
  assert.notEqual(input.before,input.after)
  assert.ok(input.before.indexOf('# H5C_RELEASE_ROUTE_BEGIN '+input.host)
    <input.before.indexOf('# H5C_RELEASE_ROUTE_BEGIN company.hi5central.com'))
  assert.ok(input.after.indexOf('# H5C_RELEASE_ROUTE_BEGIN '+input.host)
    >input.after.indexOf('# H5C_RELEASE_ROUTE_BEGIN company.hi5central.com'))
 })
 test(stage+' rejects altered other customer, shared configuration, target and stage',()=>{
  const input=fixture(stage)
  for(const after of [
   input.after.replace('companymanaged.hi5central.com','unexpected.hi5central.com'),
   input.after.replace('# H5C_RELEASE_ROUTE_INSERT','# H5C_RELEASE_ROUTE_INSERT_CHANGED'),
   input.after.replace('reverse_proxy hi5pool-'+stage+'-'+restoreSha.slice(0,12)+'-api:3001',
    'reverse_proxy untrusted-api:3001'),
   input.after.replace('  # H5C_RELEASE_ROUTE_INSERT','  respond "off"\n  # H5C_RELEASE_ROUTE_INSERT'),
  ]){
   assert.throws(()=>assertTenantOnlyGatewayMutation({...input,after}),/Another customer/)
  }
  assert.throws(()=>assertTenantOnlyGatewayMutation({...input,buildSha:beforeSha}),
   /Another customer/)
  assert.throws(()=>assertTenantOnlyGatewayMutation({...input,host:'other.hi5central.com'}),
   /Original customer route marker/)
 })
}
test('real stage worker supplies exact tenant, environment and target to gateway verifier',()=>{
 const worker=readFileSync(new URL('../src/stageRollbackExecution.mjs',import.meta.url),'utf8')
 assert.match(worker,/assertTenantOnlyGatewayMutation\(\{before,after,host:hostname,/)
 assert.match(worker,/tenantSlug:job\.tenantSlug,stage,buildSha:job\.toSha/)
})
