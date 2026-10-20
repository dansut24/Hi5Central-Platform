import test from 'node:test'
import assert from 'node:assert/strict'
import {canRetryFailedProductionRollbackWithHold,queueRollback} from '../src/stageRollbackControl.js'

const tenantId='52b02c05-b454-4acc-80cc-90f7adfe0866'
const userId='ab10952e-dadf-4d24-b340-2f1e3a556a34'
const originalId='4192acc2-726b-41f0-bc6d-3d670962650f'
const sha='96b9edbcf1631ce9719884c3e3f1700907a6eff0'
const target='d05e592ef6e43a494e685f77964b4f9a4eef2c30'
const generation=1792474715246
const intent={fromSha:sha,toSha:target,generation}
const original={id:originalId}
const prior={
 state:'failed',requested_via:'hi5central_admin',matches_hold_origin:true,
 source_build_sha:sha,target_build_sha:target,source_route_generation:generation,
 original_release_job_id:originalId,
}

test('only identical, hold-originating failed Production request permits another audited request',()=>{
 assert.equal(canRetryFailedProductionRollbackWithHold({prior,intent,original}),true)
 for(const patch of [
  {state:'requested'},{state:'running'},{state:'verified'},{state:'cancelled'},
  {requested_via:'custom_customer'},{matches_hold_origin:false},
  {source_build_sha:target},{target_build_sha:sha},
  {source_route_generation:generation+1},
  {original_release_job_id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'},
 ]){
  assert.equal(canRetryFailedProductionRollbackWithHold({
   prior:{...prior,...patch},intent,original,
  }),false,JSON.stringify(patch))
 }
 assert.equal(canRetryFailedProductionRollbackWithHold({
  prior,intent:{...intent,toSha:sha},original,
 }),false)
})

function fixture({holdActive=true,last=prior}={}){
 const statements=[]
 const db={async query(sql,params){
  sql=String(sql);statements.push(sql)
  if(sql.includes("pg_advisory_xact_lock("))return {rows:[{}],rowCount:1}
  if(sql.includes('FROM tenants t JOIN tenant_release_preferences p'))
   return {rows:[{id:tenantId,slug:'companycustom',status:'active',update_mode:'admin_controlled'}],rowCount:1}
  if(sql.includes('SELECT environment,pool_id,build_sha,generation'))
   return {rows:[{environment:'live',pool_id:'h5pool-live-96b9edbcf163',build_sha:sha,generation}],rowCount:1}
  if(sql.includes('FROM tenant_runtime_route_attestations'))
   return {rows:[{pool_id:'h5pool-live-96b9edbcf163',build_sha:sha,public_host:'companycustom.hi5central.com',state:'active',checked_at:new Date()}],rowCount:1}
  if(sql.includes('AS backed_up'))
   return {rows:[{id:originalId,build_sha:sha,previous_build_sha:target,status:'succeeded',backed_up:true}],rowCount:1}
  if(sql.includes('SELECT 1 FROM tenant_release_rollout_jobs')
    ||sql.includes('SELECT 1 FROM platform_release_rollback_jobs'))
   return {rows:[],rowCount:0}
  if(sql.includes('SELECT active FROM tenant_release_upgrade_holds'))
   return {rows:holdActive?[{active:true}]:[],rowCount:holdActive?1:0}
  if(sql.includes('AS matches_hold_origin'))
   return {rows:last?[last]:[],rowCount:last?1:0}
  if(sql.includes('INSERT INTO tenant_release_upgrade_holds'))
   return {rows:[{tenant_id:tenantId}],rowCount:1}
  if(sql.includes('INSERT INTO platform_release_rollback_jobs'))
   return {rows:[{id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',state:'requested',environment:'live',source_build_sha:sha,target_build_sha:target}],rowCount:1}
  if(sql.includes('INSERT INTO platform_release_rollback_events'))
   return {rows:[],rowCount:1}
  throw Error('Unrecognised fixture SQL '+sql.slice(0,180))
 }}
 return {db,statements}
}
const body={
 confirm:'HI5CENTRAL_ROLLBACK_CONFIRMED',environment:'live',
 fromBuildSha:sha,toBuildSha:target,routeGeneration:generation,
 reason:'Retry administrator Production rollback after the repaired worker was verified.',
}
const request={tenantId,userId,actor:'platform_admin',body}

test('retries exact failed Production rollback without deleting or releasing existing hold',async()=>{
 const {db,statements}=fixture()
 const result=await queueRollback(db,request)
 assert.equal(result.environment,'live')
 assert.ok(statements.some(x=>x.includes('AS matches_hold_origin')))
 assert.ok(statements.some(x=>x.includes('INSERT INTO platform_release_rollback_jobs')))
 assert.ok(statements.some(x=>x.includes('INSERT INTO platform_release_rollback_events')))
 assert.ok(!statements.some(x=>x.includes('INSERT INTO tenant_release_upgrade_holds')))
 assert.ok(!statements.some(x=>x.includes('DELETE FROM tenant_release_upgrade_holds')))
 assert.ok(!statements.some(x=>x.includes('active=false')))
})
test('never reuses another active hold, running request or mismatched route',async()=>{
 for(const mismatch of [{state:'verified'},{state:'running'},{matches_hold_origin:false},
   {source_route_generation:generation+1},{target_build_sha:sha}]){
  const {db,statements}=fixture({last:{...prior,...mismatch}})
  await assert.rejects(()=>queueRollback(db,request),/hold does not match/)
  assert.ok(!statements.some(x=>x.includes('INSERT INTO platform_release_rollback_jobs')))
 }
})
test('first Production rollback creates its hold normally',async()=>{
 const {db,statements}=fixture({holdActive:false})
 await queueRollback(db,request)
 assert.ok(statements.some(x=>x.includes('INSERT INTO tenant_release_upgrade_holds')))
})
