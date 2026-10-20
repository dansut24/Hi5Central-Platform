import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {assertUnassignedLiveFallbackBaseline,assertUnassignedSandboxBaseline} from '../src/tenantFirstStageBaseline.js'
import {prepareSharedTenantCaddyRoute,undoTenantCaddyRoute} from '../src/tenantCaddyVersionRoutes.js'

const sha='96b9edbcf1631ce9719884c3e3f1700907a6eff0'
const host='newtest.hi5central.com'
const source=[
'*.hi5central.com {',
'  # H5C_RELEASE_ROUTE_INSERT',
'  handle {',
'    @apiRequest path /api/* /live /health',
'    handle @apiRequest {',
'      reverse_proxy api:3001',
'    }',
'    handle {',
'      reverse_proxy itsm:80',
'    }',
'  }',
'}',
].join('\n')
const valid={environment:'live',host,source,apiSha:sha,webSha:sha,targetSha:sha}

test('first Managed Production route accepts exact verified shared fallback without a previous SHA',()=>{
 assert.deepEqual(assertUnassignedLiveFallbackBaseline(valid),{sha:null,unassigned:true})
 const planned=prepareSharedTenantCaddyRoute({
  config:source,tenantSlug:'newtest',environment:'live',buildSha:sha,
 })
 assert.match(planned.config,/H5C_RELEASE_ROUTE_BEGIN newtest\.hi5central\.com/)
 const original=undoTenantCaddyRoute({current:planned.config,original:source,host})
 assert.equal(original,source)
 assert.deepEqual(assertUnassignedLiveFallbackBaseline({...valid,source:original}),
  {sha:null,unassigned:true})
})

test('first Live route rejects existing dedicated route, wrong host and stage',()=>{
 const active=prepareSharedTenantCaddyRoute({
  config:source,tenantSlug:'newtest',environment:'live',buildSha:sha,
 })
 for(const patch of [
  {source:active.config},{environment:'uat'},
  {host:'newtest-uat.hi5central.com'},{host:'api.hi5central.com',source:''},
  {source:source.replace('  # H5C_RELEASE_ROUTE_INSERT','')},
  {source:source.replace('reverse_proxy api:3001','respond "bad" 200')},
  {source:source.replace('reverse_proxy itsm:80','respond "bad" 200')},
 ]){
  assert.throws(()=>assertUnassignedLiveFallbackBaseline({...valid,...patch}))
 }
})
test('first Live route refuses mixed, stale or unapproved fallback API/web revisions',()=>{
 for(const patch of [
  {apiSha:'a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'},
  {webSha:'a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'},
  {targetSha:'not-a-release'},
  {targetSha:'d05e592ef6e43a494e685f77964b4f9a4eef2c30'},
 ]){
  assert.throws(()=>assertUnassignedLiveFallbackBaseline({...valid,...patch}))
 }
})
test('sandbox bootstrap still requires exact 503 and cannot use shared fallback',()=>{
 assert.throws(()=>assertUnassignedSandboxBaseline({
  environment:'uat',host:'newtest-uat.hi5central.com',source,
  status:'200',body:'{"sha":"'+sha+'"}',
 }))
})
test('host deployer treats only truly tenant-specific Live routes as installed',()=>{
 const script=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 assert.match(script,/if\(snapshot\.includes\(marker\)\)/)
 assert.match(script,/if\(environment==='live'\)return assertUnassignedLiveFallbackBaseline/)
 assert.match(script,/apiSha:await shaPublic\('https:\/\/'\+host\+'\/api\/v1\/updates\/version'\)/)
 assert.match(script,/webSha:await shaPublic\('https:\/\/'\+host\+'\/release-manifest\.json'\)/)
 assert.match(script,/if\(prior===sha\)throw Error/)
 assert.match(script,/assertCurrentFencedHostLease\(\)/)
})
