import test from 'node:test'
import assert from 'node:assert/strict'
import {supersedeScheduledReleaseJobs as supersede} from '../src/rolloutJobSupersession.js'
const oldSha='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
const newSha='ff3795f7d1bc5d256ced5142b578c0897f57f6a7'
const actorId='2a9e45a0-6d32-4cf1-9a42-17b52b7e7e10'
const pairs=[{slug:'custom1',environment:'uat'},
  {slug:'custom2',environment:'uat'},
  {slug:'h5c-custom-qa26',environment:'uat'},
  {slug:'h5c-managed-qa26',environment:'live'},
  {slug:'managed1',environment:'live'},
  {slug:'managed2',environment:'live'}]
const jobs=pairs.map((x,i)=>({
 ...x,id:'1a111111-1111-4111-8111-'+String(i).padStart(12,'0'),
 tenant_id:'2a222222-2222-4222-8222-'+String(i).padStart(12,'0'),
 build_sha:oldSha,status:'scheduled',attempt_count:0,lease_token:null,
 lease_expires_at:null,lease_fence:'0',routed_generation:null}))
const request={oldSha,newSha,expected:pairs,actorId,
 reason:'Superseded by the newly published official QA customer release'}
function mock({paused=true,active=0,published=true,rows=jobs,updated=jobs}={}){
 const calls=[]
 const db={async query(sql,params){
  calls.push({sql,params})
  if(sql.includes('FROM platform_release_rollout_control'))
   return {rows:[{paused}],rowCount:1}
  if(sql.includes("count(*)::int AS total"))
   return {rows:[{total:active}],rowCount:1}
  if(sql.includes('FROM hi5central_published_release_notes'))
   return {rows:published?[{build_sha:newSha}]:[],rowCount:published?1:0}
  if(sql.includes('FOR UPDATE OF j'))
   return {rows,rowCount:rows.length}
  if(sql.includes('UPDATE tenant_release_rollout_jobs'))
   return {rows:updated,rowCount:updated.length}
  if(sql.includes('INSERT INTO tenant_release_rollout_events'))
   return {rows:[],rowCount:1}
  throw Error('Unexpected SQL: '+sql)
 }}
 return {db,calls}
}
test('six exact unclaimed jobs cancelled, with six separately recorded audit events',async()=>{
 const {db,calls}=mock()
 const result=await supersede(db,request)
 assert.equal(result.cancelled,6)
 assert.equal(result.auditEvents,6)
 assert.equal(result.globallyPaused,true)
 assert.equal(result.routeChanges,0)
 assert.equal(calls.filter(x=>x.sql.includes('INSERT INTO tenant_release_rollout_events')).length,6)
 assert.equal(calls.filter(x=>x.sql.includes('UPDATE tenant_release_rollout_jobs')).length,1)
 assert(calls.some(x=>x.sql.includes('FOR UPDATE OF j')))
 assert(calls.every(x=>!x.sql.includes('platform_release_rollout_control SET')))
 assert(calls.every(x=>!x.sql.includes('docker')&&!x.sql.includes('Caddy')))
 for(const event of calls.filter(x=>x.sql.includes('INSERT INTO tenant_release_rollout_events'))){
  const detail=JSON.parse(event.params[5])
  assert.equal(detail.supersededBy,newSha)
  assert.equal(detail.staffActorId,actorId)
 }
})
test('blocks missing publication, unpaused fleet and running jobs before touching queue',async()=>{
 for(const state of [{paused:false},{active:1},{published:false}]){
  const {db,calls}=mock(state)
  await assert.rejects(supersede(db,request),/paused|running|published/)
  assert(!calls.some(x=>x.sql.includes('UPDATE tenant_release_rollout_jobs')))
 }
})
test('blocks unexpected cohorts, claimed, routed, attempted and deferred jobs',async()=>{
 for(const rows of [
  jobs.slice(0,5),
  [...jobs,{...jobs[0],slug:'additional'}],
  jobs.map((x,i)=>i===0?{...x,slug:'unexpected'}:x),
  jobs.map((x,i)=>i===0?{...x,status:'running'}:x),
  jobs.map((x,i)=>i===0?{...x,status:'deferred'}:x),
  jobs.map((x,i)=>i===0?{...x,attempt_count:1}:x),
  jobs.map((x,i)=>i===0?{...x,lease_fence:1}:x),
  jobs.map((x,i)=>i===0?{...x,lease_token:actorId}:x),
  jobs.map((x,i)=>i===0?{...x,routed_generation:1}:x),
 ]){
  const {db,calls}=mock({rows})
  await assert.rejects(supersede(db,request),/reviewed|claimed|count|scope/)
  assert(!calls.some(x=>x.sql.includes('UPDATE tenant_release_rollout_jobs')))
 }
})
test('rejects invalid staff identity, weak reason, swapped build and duplicate scope before any query',async()=>{
 for(const change of [
  {actorId:'not-staff'}, {reason:'ok'}, {newSha:oldSha},
  {newSha:'bad-sha'}, {expected:[pairs[0],pairs[0]]},
  {expected:[{slug:'../unsafe',environment:'live'}]},
  {expected:[]},
 ]){
  const {db,calls}=mock()
  await assert.rejects(supersede(db,{...request,...change}))
  assert.equal(calls.length,0)
 }
})
test('refuses partial update results so caller must roll back its transaction and audit',async()=>{
 const {db,calls}=mock({updated:jobs.slice(0,5)})
 await assert.rejects(supersede(db,request),/Concurrent queue modification/)
 assert.equal(calls.filter(x=>x.sql.includes('INSERT INTO tenant_release_rollout_events')).length,0)
})
