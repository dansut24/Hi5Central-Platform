import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {
  rollbackRequestPayload,evaluateCustomerRollback,requestCustomerRollback,
} from '../src/customerProductionRollback.js'
const source='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const target='a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'
const id='11111111-1111-4111-8111-111111111111'
const person='22222222-2222-4222-8222-222222222222'
const job='1e53479b-7c36-44d7-8bda-656955db7027'
const now=new Date('2026-10-19T14:02:00Z')
const body={confirm:'ROLLBACK_MY_CUSTOM_PRODUCTION',fromBuildSha:source,toBuildSha:target,
  routeGeneration:1792412068014,reason:'UAT acceptance passed but Production regression now requires the verified previous application build.'}
const success={
 mode:'admin_controlled',slug:'companycustom',
 current:{environment:'live',pool_id:'h5pool-live-79d95f3ffa2a',build_sha:source,
   generation:1792412068014},
 route:{environment:'live',pool_id:'h5pool-live-79d95f3ffa2a',build_sha:source,
   public_host:'companycustom.hi5central.com',state:'active',
   checked_at:new Date('2026-10-19T14:01:00Z')},
 verifiedJob:{id:job,status:'succeeded',environment:'live',build_sha:source,
   previous_build_sha:target,has_verified_event:true,
   previous_gateway_backup:'release-live-1792412065513-companycustom-hi5central-com'},
 compatibility:{from_build_sha:source,to_build_sha:target,state:'approved',
   schema_backward_compatible:true,immutable_images_verified:true,
   recovery_snapshot_verified:true,reviewed_by:person,
   reviewed_at:new Date('2026-10-19T13:58:00Z'),
   expires_at:new Date('2026-10-20T14:00:00Z'),
   evidence:{schemaChecked:true,previousImagePulled:true,recoveryTestPassed:true}},
 activeHold:null,activeRequest:null,activeRolloutCount:0,executorReady:true,now,
}
test('request requires exact build pair, route generation, explicit confirmation and reason',()=>{
 assert.deepEqual(rollbackRequestPayload(body),{
  fromBuildSha:source,toBuildSha:target,
  routeGeneration:body.routeGeneration,reason:body.reason,
 })
 for(const bad of [
  {confirm:'yes'},{fromBuildSha:'abc'},{toBuildSha:source},
  {routeGeneration:'1792412068014'},{routeGeneration:0},
  {routeGeneration:-1},{routeGeneration:1.2},{reason:'short'},
  {reason:'x'.repeat(1001)},
 ])assert.throws(()=>rollbackRequestPayload({...body,...bad}))
})
test('eligible Custom Production request needs fresh exact route and approved safe rollback pair',()=>{
 const result=evaluateCustomerRollback(success)
 assert.equal(result.canRequest,true)
 assert.deepEqual(result.reasons,[])
 assert.equal(result.installedBuildSha,source)
 assert.equal(result.previousBuildSha,target)
 assert.equal(result.sourceRouteGeneration,body.routeGeneration)
 assert.equal(result.matchedReleaseJobId,job)
})
test('rollback fails closed on unsafe tenants, route drift, missing compatibility and untested executors',()=>{
 const failures=[
  {mode:'hi5_managed'},{slug:'companymanaged'},
  {current:null},{current:{...success.current,build_sha:target}},
  {current:{...success.current,generation:0}},
  {route:null},{route:{...success.route,build_sha:target}},
  {route:{...success.route,checked_at:new Date('2026-10-19T13:30:00Z')}},
  {route:{...success.route,public_host:'company.hi5central.com'}},
  {verifiedJob:null},{verifiedJob:{...success.verifiedJob,status:'rolled_back'}},
  {verifiedJob:{...success.verifiedJob,has_verified_event:false}},
  {verifiedJob:{...success.verifiedJob,previous_gateway_backup:null}},
  {compatibility:null},{compatibility:{...success.compatibility,state:'blocked'}},
  {compatibility:{...success.compatibility,schema_backward_compatible:false}},
  {compatibility:{...success.compatibility,immutable_images_verified:false}},
  {compatibility:{...success.compatibility,recovery_snapshot_verified:false}},
  {compatibility:{...success.compatibility,
    expires_at:new Date('2026-10-18T00:00:00Z')}},
  {compatibility:{...success.compatibility,evidence:{schemaChecked:true}}},
  {activeHold:{active:true}},{activeRequest:{id}},
  {activeRolloutCount:1},{executorReady:false},
 ]
 for(const patch of failures){
  const result=evaluateCustomerRollback({...success,...patch})
  assert.equal(result.canRequest,false,'Unsafe state admitted: '+Object.keys(patch).join(','))
  assert.ok(result.reasons.length>0)
 }
})
test('no request or hold can be written before independently certified executor is activated',async()=>{
 const sql=[]
 const db={query:async (query)=>{sql.push(query);return {rowCount:0,rows:[]}}}
 await assert.rejects(requestCustomerRollback(db,{
  tenantId:id,userId:person,body,executorReady:false,now,
 }))
 assert.equal(sql.some(x=>x.includes('INSERT INTO tenant_release_upgrade_holds')),false)
 assert.equal(sql.some(x=>x.includes('INSERT INTO tenant_release_customer_rollback_requests')),false)
})
test('customer rollback API is tenant-scoped, UAT-only, and hard-off without a stage worker',()=>{
 const code=readFileSync(new URL('../src/tenantRelease.js',import.meta.url),'utf8')
 assert.match(code,/app\.get\('\/api\/v1\/release-management\/rollback'/)
 assert.match(code,/app\.post\('\/api\/v1\/release-management\/rollback'/)
 assert.match(code,/const auth=await requireTenantAdmin\(c\)/)
 assert.match(code,/if\(deployment\.runtimeEnvironment!=='live'\)/)
 assert.match(code,/process\.env\.H5C_STAGE_ROLLBACK_QUEUE_READY!=='true'/)
 assert.match(code,/body\?\.environment!=='uat'/)
 assert.match(code,/release\.custom_uat_rollback_requested/)
 assert.doesNotMatch(code,/ROLLBACK_MY_CUSTOM_PRODUCTION/)
 const customer=readFileSync(new URL('../../../apps/itsm/src/features/settings/TenantRuntimeUpdates.jsx',import.meta.url),'utf8')
 assert.match(customer,/data-hi5-customer-rollback/)
 assert.match(customer,/rollback\?\.canRequest/)
 assert.match(customer,/ROLLBACK_MY_CUSTOM_UAT/)
 assert.match(customer,/Roll back UAT/)
 assert.doesNotMatch(customer,/Request Production rollback/)
})
