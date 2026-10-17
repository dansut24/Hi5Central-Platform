import test from 'node:test'
import assert from 'node:assert/strict'
import {assessCustomerRollback,requestCustomerRollback} from '../src/customerReleaseRollback.js'

const A='a'.repeat(40),B='b'.repeat(40)
const TENANT='123e4567-e89b-42d3-a456-426614174000'
const ACTOR='123e4567-e89b-42d3-a456-426614174001'
const currentTime=new Date('2026-10-17T14:00:00Z')
const approved=new Date('2026-10-17T13:00:00Z')
const yes={
 tenant:{status:'active',itsm:true,slug:'example',update_mode:'hi5_managed'},
 assignment:{environment:'live',pool_id:'h5live-new',build_sha:A,generation:8},
 route:{environment:'live',state:'active',build_sha:A,pool_id:'h5live-new',
  public_host:'example.hi5central.com',checked_at:'2026-10-17T13:59:00Z'},
 lastJob:{environment:'live',status:'succeeded',build_sha:A,previous_build_sha:B},
 compatibility:{from_build_sha:A,to_build_sha:B,state:'approved',
  schema_backward_compatible:true,immutable_images_verified:true,
  recovery_snapshot_verified:true,reviewed_by:ACTOR,
  reviewed_at:approved,expires_at:'2026-10-18T14:00:00Z'},
 activeRollout:false,activeRequest:false,now:currentTime,
}
test('isolated eligible tenant may request only immediate compatible predecessor',()=>{
 const result=assessCustomerRollback(yes)
 assert.equal(result.available,true)
 assert.equal(result.currentBuildSha,A)
 assert.equal(result.targetBuildSha,B)
 assert.equal(result.routeGeneration,8)
})
test('wrong tenant host, stale route or changed build is rejected',()=>{
 for(const mod of [
  {route:{...yes.route,public_host:'another.hi5central.com'}},
  {route:{...yes.route,checked_at:'2026-10-17T13:15:00Z'}},
  {route:{...yes.route,build_sha:B}},
  {assignment:{...yes.assignment,build_sha:B}},
  {assignment:{...yes.assignment,generation:0}},
  {tenant:{...yes.tenant,itsm:false}},
  {tenant:{...yes.tenant,status:'archived'}},
  {activeRollout:true},{activeRequest:true},
 ]){
  assert.equal(assessCustomerRollback({...yes,...mod}).available,false,JSON.stringify(mod))
 }
})
test('no unreviewed image, schema or recovery snapshot may bypass host guard',()=>{
 const bad=[
  {state:'blocked'},
  {schema_backward_compatible:false},
  {immutable_images_verified:false},
  {recovery_snapshot_verified:false},
  {expires_at:'2026-10-16T14:00:00Z'},
  {to_build_sha:'c'.repeat(40)},
  {reviewed_by:null},
 ]
 for(const override of bad){
  assert.equal(assessCustomerRollback({...yes,compatibility:{...yes.compatibility,...override}}).available,false,
   JSON.stringify(override))
 }
})
test('the lack of any proven predecessor is denied, even if another arbitrary image exists',()=>{
 assert.equal(assessCustomerRollback({...yes,lastJob:{...yes.lastJob,previous_build_sha:null}}).available,false)
 assert.equal(assessCustomerRollback({...yes,lastJob:{...yes.lastJob,previous_build_sha:A}}).available,false)
})
test('malformed and unconfirmed rollback requests cannot touch the DB',async()=>{
 let calls=0
 const db={query:async()=>{calls++}}
 for(const data of [
  {confirmed:false,reason:'The current build causes a major incident in our organisation.'},
  {confirmed:true,reason:'short'},
  {confirmed:true,reason:'The current build causes a major incident in our organisation.',targetBuildSha:A},
 ]){
  await assert.rejects(requestCustomerRollback({
   db,tenantId:TENANT,userId:ACTOR,expectedCurrentSha:A,targetBuildSha:B,
   now:currentTime,...data}),err=>err.status===400)
 }
 assert.equal(calls,0)
})
test('request holds only the authenticated tenant: scoped parameterised SQL and audited cancellations',async()=>{
 const queries=[],candidate={...yes,now:currentTime}
 let pending=[{id:'123e4567-e89b-42d3-a456-426614174088',environment:'live',
  build_sha:'c'.repeat(40),lease_fence:0}]
 const db={query:async(sql,params)=>{
  queries.push({sql,params})
  if(sql.includes('SELECT t.id,t.slug'))return {rows:[{id:TENANT,...candidate.tenant}],rowCount:1}
  if(sql.includes('FROM tenant_runtime_assignments'))return {rows:[candidate.assignment],rowCount:1}
  if(sql.includes('FROM tenant_runtime_route_attestations'))return {rows:[candidate.route],rowCount:1}
  if(sql.includes('FROM tenant_release_rollout_jobs WHERE tenant_id=$1')&&sql.includes("status='succeeded'"))
   return {rows:[candidate.lastJob],rowCount:1}
  if(sql.includes('FROM tenant_release_rollout_jobs WHERE tenant_id=$1')&&sql.includes("status='running'"))
   return {rows:[],rowCount:0}
  if(sql.includes('FROM tenant_release_customer_rollback_requests')&&sql.includes("state IN"))
   return {rows:[],rowCount:0}
  if(sql.includes('FROM tenant_release_upgrade_holds'))return {rows:[],rowCount:0}
  if(sql.includes('FROM platform_release_rollback_compatibility'))return {rows:[candidate.compatibility],rowCount:1}
  if(sql.includes('SELECT id,source_build_sha,target_build_sha'))return {rows:[],rowCount:0}
  if(sql.includes('UPDATE tenant_release_rollout_jobs'))return {rows:pending,rowCount:pending.length}
  if(sql.includes('INSERT INTO tenant_release_customer_rollback_requests'))
   return {rows:[{id:'123e4567-e89b-42d3-a456-426614174033',
    tenant_id:TENANT,source_build_sha:A,target_build_sha:B,state:'requested'}],rowCount:1}
  return {rows:[],rowCount:1}
 }}
 const result=await requestCustomerRollback({
  db,tenantId:TENANT,userId:ACTOR,expectedCurrentSha:A,targetBuildSha:B,confirmed:true,
  reason:'The new ITSM release prevents our staff from working on critical incidents.',now:currentTime})
 assert.equal(result.productionChanged,false)
 assert.equal(result.upgradeHold,true)
 assert.equal(result.cancelledForwardJobs,1)
 const hold=queries.find(x=>x.sql.includes('INSERT INTO tenant_release_upgrade_holds'))
 assert.deepEqual(hold.params.slice(0,1),[TENANT])
 assert(queries.find(x=>x.sql.includes('FOR UPDATE OF t')))
 const cancelled=queries.find(x=>x.sql.includes('UPDATE tenant_release_rollout_jobs'))
 assert.equal(cancelled.params[0],TENANT)
 assert(queries.some(x=>x.sql.includes('INSERT INTO tenant_release_rollout_events')))
 assert(queries.some(x=>x.sql.includes('INSERT INTO tenant_release_customer_rollback_events')))
 assert(!queries.some(x=>/docker|Caddy|--apply/.test(x.sql)))
})
