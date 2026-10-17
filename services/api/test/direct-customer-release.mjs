import test from 'node:test'
import assert from 'node:assert/strict'
import {authoriseDirectCustomerReleaseStages} from '../src/certifiedReleaseFanout.js'

const sha='f'.repeat(40)
const actorId='f124ae69-9191-485d-86a8-18082333233d'
const ciRunUrl='https://github.com/dansut24/Hi5Central-Platform/actions/runs/123456789'
function dbFixture({certified=true,revoked=false}={}){
 const statements=[],auth=[]
 return {statements,auth,query:async(q,args=[])=>{
  const sql=String(q)
  statements.push(sql)
  if(sql.includes('SELECT c.build_sha FROM platform_certified_application_releases'))
   return {rowCount:certified?1:0,rows:certified?[{build_sha:sha}]:[]}
  if(sql.startsWith('INSERT INTO platform_release_generic_stage_approvals')){
   auth.push({stage:args[1],evidence:JSON.parse(args[3])})
   return {rowCount:1,rows:[]}
  }
  if(sql.startsWith('SELECT environment,planning_enabled,execution_enabled')){
   const rows=['uat','live'].map(environment=>({
    environment,planning_enabled:!revoked,execution_enabled:!revoked,
    approved_by:actorId,expires_at:new Date(Date.now()+3600000).toISOString(),
    evidence:{releaseToCustomers:true},
   }))
   return {rowCount:rows.length,rows}
  }
  throw Error('Unexpected release SQL: '+sql)
 }}
}
test('one click authorises UAT and Live from one officially certified SHA only',async()=>{
 const db=dbFixture()
 const result=await authoriseDirectCustomerReleaseStages(db,{sha,actorId,ciRunUrl})
 assert.deepEqual(result.stages,['uat','live'])
 assert.equal(result.executionAuthorised,true)
 assert.deepEqual(db.auth.map(x=>x.stage),['uat','live'])
 assert(db.auth.every(x=>x.evidence.releaseToCustomers===true
  &&x.evidence.sourceSha===sha))
 assert(db.statements.every(x=>!x.includes('platform_release_rollout_control')))
 assert(db.statements.every(x=>!x.includes('platform_release_test_qa_gates')))
})
test('uncertified release cannot grant or queue any stage',async()=>{
 const db=dbFixture({certified:false})
 await assert.rejects(authoriseDirectCustomerReleaseStages(db,{sha,actorId,ciRunUrl}),
  /Official release verification/)
 assert.equal(db.auth.length,0)
})
test('revoked stage blocks reauthorisation of same SHA',async()=>{
 const db=dbFixture({revoked:true})
 await assert.rejects(authoriseDirectCustomerReleaseStages(db,{sha,actorId,ciRunUrl}),
  /previously revoked/)
})
test('invalid actor or SHA cannot access the database',async()=>{
 const db=dbFixture()
 await assert.rejects(authoriseDirectCustomerReleaseStages(db,{
  sha:'nope',actorId,ciRunUrl}),/immutable build/)
 await assert.rejects(authoriseDirectCustomerReleaseStages(db,{
  sha,actorId:'not-a-user',ciRunUrl}),/immutable build/)
 assert.equal(db.statements.length,0)
})
