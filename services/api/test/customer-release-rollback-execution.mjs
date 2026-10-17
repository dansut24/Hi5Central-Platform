import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyCustomerRollbackHostProof,claimNextCustomerRollback,
 completeCustomerRollback,failCustomerRollback} from '../src/customerReleaseRollbackExecution.js'

const request={id:'d43abe7a-69d2-4f56-bf89-c3f06d48c789',
 tenant_id:'5a77301d-d379-4a0f-b0a1-104709587876',
 state:'running',environment:'live',
 source_build_sha:'a'.repeat(40),target_build_sha:'b'.repeat(40),
 source_route_generation:200}
const now=new Date('2026-10-17T18:00:00Z')
const proof={status:'rollback_verified',requestId:request.id,
 tenantId:request.tenant_id,environment:'live',sourceBuildSha:request.source_build_sha,
 observedBuildSha:request.target_build_sha,routeGeneration:201,
 checkedAt:'2026-10-17T17:59:30Z',apiHealthy:true,
 frontendHealthy:true,gatewaySourceAgreed:true,tenantScopedRouteOnly:true}

test('exact tenant/version and fresh gateway proof are needed for customer rollback',()=>{
 assert.equal(verifyCustomerRollbackHostProof({request,proof,now}).ok,true)
 for(const mismatch of [
  {tenantId:'5a77301d-d379-4a0f-b0a1-104709587877'},
  {sourceBuildSha:'c'.repeat(40)},
  {observedBuildSha:'c'.repeat(40)},
  {requestId:'d43abe7a-69d2-4f56-bf89-c3f06d48c780'},
  {routeGeneration:200},
  {routeGeneration:199},
  {checkedAt:'2026-10-17T17:55:00Z'},
  {checkedAt:'2026-10-17T18:01:00Z'},
  {apiHealthy:false},
  {frontendHealthy:false},
  {gatewaySourceAgreed:false},
  {tenantScopedRouteOnly:false},
 ]){
  const out=verifyCustomerRollbackHostProof({request,proof:{...proof,...mismatch},now})
  assert.equal(out.ok,false,JSON.stringify(mismatch))
 }
 assert.equal(verifyCustomerRollbackHostProof({
  request:{...request,state:'requested'},proof,now}).ok,false)
})
test('global release safety pause blocks rollback claim, leaves tenant untouched',async()=>{
 const sql=[]
 const db={query:async q=>{sql.push(String(q));return {rows:[{paused:true}]}}}
 assert.equal(await claimNextCustomerRollback(db,{now}),null)
 assert.equal(sql.length,1)
 assert.match(sql[0],/platform_release_rollout_control/)
})
test('a failed host attempt is audited and keeps the customer rollback hold',async()=>{
 const queries=[]
 const db={query:async(sql)=>{
  queries.push(String(sql))
  if(String(sql).startsWith('UPDATE tenant_release_customer_rollback_requests'))
   return {rows:[{id:request.id,tenant_id:request.tenant_id,
    source_build_sha:request.source_build_sha,target_build_sha:request.target_build_sha}],
    rowCount:1}
  return {rows:[],rowCount:1}
 }}
 const result=await failCustomerRollback(db,{requestId:request.id,reason:'HTTPS proof did not match'})
 assert.deepEqual(result,{changed:true,upgradeHoldPreserved:true})
 assert(queries.some(x=>x.includes("'failed'")))
 assert(queries.some(x=>x.includes("'failed',$3,$4")))
 assert(queries.every(x=>!x.includes('tenant_release_upgrade_holds')))
})
test('metadata completion cannot commit without fresh independent host proof',async()=>{
 const sql=[]
 const db={query:async(query)=>{
  sql.push(String(query))
  return {rows:[request],rowCount:1}
 }}
 await assert.rejects(completeCustomerRollback(db,{
  requestId:request.id,proof:{...proof,tenantScopedRouteOnly:false},now,
 }),/gateway isolation/)
 assert.equal(sql.length,1,'Invalid proof must not update a live route or release the hold')
})
