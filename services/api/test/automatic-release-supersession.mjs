import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {supersedeOlderCustomerReleases} from '../src/automaticReleaseSupersession.js'
const old='3c18b9f98d8dbf43cf7b369af822bc1f60dfe2e5'
const next='27f2378adccc1a66a84bac5a28a08ebbad835d6b'
const actor='f124ae69-9191-485d-86a8-18082333233d'
const id1='040d3a09-6f48-4a6f-b48b-d840a344633b'
const id2='03cba783-4b16-4db3-8c60-5c2d8c3d5ecc'
const tenant1='a8be0b64-1510-49e8-bc66-af7bc389f2a1'
const tenant2='b628203e-be80-4c0e-a709-5c0e8c639b7f'
function fixture({latest=next,rows=[
 {id:id1,tenant_id:tenant1,environment:'live',build_sha:old,lease_fence:0},
 {id:id2,tenant_id:tenant2,environment:'uat',build_sha:old,lease_fence:0},
]}={}){
 const statements=[],events=[]
 return {statements,events,query:async(sql,params=[])=>{
  assert.equal(typeof sql,'string','DB SQL must be string')
  statements.push({sql,params})
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[{}],rowCount:1}
  if(sql.includes('SELECT n.build_sha FROM hi5central_published_release_notes'))
   return {rows:[{build_sha:latest}],rowCount:1}
  if(sql.includes('UPDATE tenant_release_rollout_jobs j')){
    assert.deepEqual(params,[next])
    assert.match(sql,/status IN \('pending','scheduled','deferred'\)/)
    assert.match(sql,/j\.attempt_count=0/)
    assert.match(sql,/j\.lease_token IS NULL/)
    assert.match(sql,/j\.routed_generation IS NULL/)
    assert.match(sql,/j\.environment IN \('uat','live'\)/)
    return {rows,rowCount:rows.length}
  }
  if(sql.includes('INSERT INTO tenant_release_rollout_events')){
   assert.equal(params[4],'number'===typeof params[4]?params[4]:params[4])
   assert.equal(JSON.parse(params[5]).supersededBy,next)
   assert.equal(JSON.parse(params[5]).reason,'superseded_by_newer_certified_customer_release')
   events.push(params)
   return {rows:[],rowCount:1}
  }
  throw Error('Unexpected query: '+sql)
 }}
}
test('new staff release cancels two old unclaimed jobs and writes an event per job',async()=>{
 const f=fixture()
 const result=await supersedeOlderCustomerReleases(f,{newSha:next,actorId:actor})
 assert.equal(result.supersededCount,2)
 assert.deepEqual(result.supersededJobIds,[id1,id2])
 assert.equal(f.events.length,2)
 assert.deepEqual(f.events.map(p=>p[3]),[old,old])
})
test('no old queued jobs is valid and does not create phantom audit events',async()=>{
 const f=fixture({rows:[]})
 const result=await supersedeOlderCustomerReleases(f,{newSha:next,actorId:actor})
 assert.equal(result.supersededCount,0)
 assert.equal(f.events.length,0)
})
test('the superseded release may never publish again after a newer release',async()=>{
 const f=fixture({latest:next})
 await assert.rejects(supersedeOlderCustomerReleases(f,{newSha:old,actorId:actor}),/newest/)
 assert.equal(f.statements.filter(x=>x.sql.includes('UPDATE tenant_release_rollout_jobs')).length,0)
})
test('unauthenticated or malformed revisions cannot affect the database',async()=>{
 const f=fixture()
 await assert.rejects(supersedeOlderCustomerReleases(f,{newSha:'bogus',actorId:actor}),/verified staff actor/)
 await assert.rejects(supersedeOlderCustomerReleases(f,{newSha:next,actorId:'bad'}),/verified staff actor/)
 assert.equal(f.statements.length,0)
})
test('central certification supersedes before queue fanout, with audit in same transaction',()=>{
 const routes=readFileSync(new URL('../src/certifiedTenantReleaseRoutes.js',import.meta.url),'utf8')
 const start=routes.indexOf("if(releaseToCustomers){\n          // One staff decision")
 assert(start>=0)
 const subset=routes.slice(start,start+1900)
 assert(subset.indexOf('supersedeOlderCustomerReleases')>=0)
 assert(subset.indexOf('supersedeOlderCustomerReleases')<subset.indexOf('fanoutCertifiedRelease'))
 assert.match(subset,/supersededJobIds/)
 assert.match(subset,/VALUES\(\$1,'release_to_customers',\$2,\$3::jsonb\)/)
})
test('worker verifies current latest staff release for each UAT/Live stage before claim',()=>{
 const queue=readFileSync(new URL('../src/tenantReleaseQueue.js',import.meta.url),'utf8')
 assert.match(queue,/j\.environment='test' OR j\.build_sha=/)
 assert.match(queue,/n2\.published_at DESC/)
 assert.match(queue,/a2\.environment=j\.environment/)
 assert.match(queue,/a2\.execution_enabled=true/)
 assert.match(queue,/c2\.status='approved'/)
 assert.match(queue,/FOR UPDATE OF j SKIP LOCKED/)
})
