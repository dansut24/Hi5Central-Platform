import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {assertUnassignedSandboxBaseline} from '../src/tenantFirstStageBaseline.js'
import {prepareSharedTenantCaddyRoute,undoTenantCaddyRoute} from '../src/tenantCaddyVersionRoutes.js'

const host='companycustom-uat.hi5central.com'
const sha='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const begin='  # H5C_RELEASE_ROUTE_INSERT'
const config=[
'*.hi5central.com {',
'  @h5cUnassignedSandbox expression {http.request.host}.endsWith("-uat.hi5central.com") || {http.request.host}.endsWith("-test.hi5central.com")',
'  handle @h5cUnassignedSandbox {',
'    respond "Environment not yet deployed" 503',
'  }',
 begin,
'  handle {',
'    respond "Live is not a sandbox" 200',
'  }',
'}',
].join('\n')
const valid={environment:'uat',host,source:config,status:'503',body:'Environment not yet deployed'}

test('First Custom UAT route accepts only the exact guarded public 503 baseline',()=>{
 assert.deepEqual(assertUnassignedSandboxBaseline(valid),{sha:null,unassigned:true})
 assert.deepEqual(assertUnassignedSandboxBaseline({...valid,environment:'test',host:'companycustom-test.hi5central.com'}),{sha:null,unassigned:true})
})
test('First-stage baseline is never inferred from Live or wrong customer host',()=>{
 for(const invalid of [
  {...valid,environment:'live'},
  {...valid,host:'another-uat.hi5central.com',environment:'test'},
  {...valid,host:'companycustom.hi5central.com'},
  {...valid,host:'api.hi5central.com'},
 ]){
  assert.throws(()=>assertUnassignedSandboxBaseline(invalid))
 }
})
test('Missing fail-closed source or existing target route prohibits bootstrap',()=>{
 const active=prepareSharedTenantCaddyRoute({config,tenantSlug:'companycustom',environment:'uat',buildSha:sha})
 for(const invalid of [
  {...valid,source:config.replace('@h5cUnassignedSandbox','@another')},
  {...valid,source:config.replace('respond "Environment not yet deployed" 503','respond "Fallback" 200')},
  {...valid,source:active.config},
  {...valid,source:''},
 ]){
  assert.throws(()=>assertUnassignedSandboxBaseline(invalid))
 }
})
test('Only precise 503 and fail-closed response body can substitute for prior release',()=>{
 for(const invalid of [
  {...valid,status:'200'},
  {...valid,status:'502'},
  {...valid,status:'404'},
  {...valid,body:'{"sha":"'+sha+'"}'},
  {...valid,body:'Gateway error'},
 ]){
  assert.throws(()=>assertUnassignedSandboxBaseline(invalid))
 }
})
test('First UAT cutover remains tenant-scoped and restores exact undeployed source',()=>{
 const next=prepareSharedTenantCaddyRoute({config,tenantSlug:'companycustom',environment:'uat',buildSha:sha})
 assert.match(next.config,/H5C_RELEASE_ROUTE_BEGIN companycustom-uat\.hi5central\.com/)
 assert.match(next.config,/hi5pool-uat-79d95f3ffa2a-api/)
 assert.match(next.config,/Environment not yet deployed/)
 const previous=undoTenantCaddyRoute({current:next.config,original:config,host})
 assert.equal(previous,config)
 assert.deepEqual(assertUnassignedSandboxBaseline({...valid,source:previous}),{sha:null,unassigned:true})
})
test('Host preflight, apply and compensating restore explicitly recognise undeployed baseline',()=>{
 const script=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 assert.match(script,/async function currentRevisionOrUnassigned\(snapshot\)/)
 assert.match(script,/currentRevisionOrUnassigned\(old\)/)
 assert.match(script,/const baseline=await currentRevisionOrUnassigned\(previous\)/)
 assert.match(script,/restoredUnassigned:baseline\.unassigned/)
 assert.match(script,/body:raw\.slice\(0,separator\),status:raw\.slice\(separator\+1\)/)
 assert.match(script,/assertCurrentFencedHostLease\(\)/)
})
