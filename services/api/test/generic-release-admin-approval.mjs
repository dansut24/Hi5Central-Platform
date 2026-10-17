import test from 'node:test'
import assert from 'node:assert/strict'
import {validatedGenericPlanningRequest,approveGenericPlanningOnly,
 revokeGenericStageApproval} from '../src/genericReleaseAdminApproval.js'

const sha='d'.repeat(40)
const user='351a3c21-fd11-4674-984a-9eac9148b2c4'
const valid={
 sha,actorId:user,body:{environment:'test',confirmation:'AUTHORISE_PLANNING_ONLY',
  expiresInHours:24,reason:'Reviewed generic release planner implementation for trial tenants.',
  reviewedChange:'https://github.com/dansut24/Hi5Central-Platform/pull/79'}
}
test('planning approval requires exact platform identity, reviewed change, bounded expiry',()=>{
 const p=validatedGenericPlanningRequest(valid)
 assert.equal(p.expiresInHours,24)
 assert.equal(p.environment,'test')
 for(const request of [
  {...valid,actorId:null},
  {...valid,body:{...valid.body,environment:'production'}},
  {...valid,body:{...valid.body,confirmation:'PRODUCTION NOW'}},
  {...valid,body:{...valid.body,expiresInHours:730}},
  {...valid,body:{...valid.body,reviewedChange:'unknown'}},
  {...valid,body:{...valid.body,reason:'yes'}},
 ])assert.throws(()=>validatedGenericPlanningRequest(request))
})
test('planning endpoint cannot smuggle execution/unpause/deploy permission',()=>{
 for(const field of ['executionEnabled','execution_enabled','unpause','deployNow'])
  assert.throws(()=>validatedGenericPlanningRequest({
   ...valid,body:{...valid.body,[field]:false},
  }),/different reviewed certification/)
})
test('approved release planning forces execution=false in database operation',async()=>{
 let sql=''
 const db={query:async(q,args)=>{
  sql=String(q)
  if(sql.includes('FROM platform_certified_application_releases'))
   return {rowCount:1,rows:[{build_sha:sha}]}
  if(sql.includes('INSERT INTO platform_release_generic_stage_approvals'))
   return {rowCount:1,rows:[{build_sha:sha,environment:'test',
    planning_enabled:true,execution_enabled:false}]}
  throw Error('Unexpected generic planning statement')
 }}
 const result=await approveGenericPlanningOnly(db,valid)
 assert.equal(result.execution_enabled,false)
 assert.match(sql,/execution_enabled=false/)
 assert.match(sql,/VALUES\(\$1,\$2,true,false/)
})
test('release without certification cannot be approved',async()=>{
 const db={query:async()=>({rowCount:0,rows:[]})}
 await assert.rejects(approveGenericPlanningOnly(db,valid),/not independently certified/)
})
test('revoke resets BOTH planning and execution approval',async()=>{
 let sql=''
 const db={query:async(q)=>{sql=q;return {rows:[{environment:'uat',
  planning_enabled:false,execution_enabled:false}]}}}
 const result=await revokeGenericStageApproval(db,{sha,stage:'uat',actorId:user})
 assert.match(sql,/planning_enabled=false,execution_enabled=false/)
 assert.equal(result.execution_enabled,false)
})
