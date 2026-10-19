import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {
 certifiedRollbackExecutorReady,reviewedExecutorCertification,
} from '../src/customerProductionRollback.js'

const SHA='609255da5376d4aee71c962e9c0048e28a516566'
const REVIEWER='22222222-2222-4222-8222-222222222222'
const now=new Date('2026-10-19T15:30:00Z')
const base={
 revision_sha:SHA,state:'approved',
 worker_role:'hi5_release_rollback_executor',
 gateway_fence_tested:true,restricted_role_tested:true,
 customer_only_route_tested:true,failure_compensation_tested:true,
 public_version_verified:true,audit_completion_tested:true,
 reviewed_by:REVIEWER,reviewed_at:'2026-10-19T15:00:00Z',
 expires_at:'2026-10-20T15:00:00Z',
 reason:'Independent restricted worker review, gateway crash recovery and isolated customer route validation.',
 evidence:{independentHostTest:true,customerIsolationTest:true},
}
test('exact approved worker revision requires six independent proofs and a current staff review',()=>{
 assert.equal(reviewedExecutorCertification(base,SHA,now),true)
 for(const invalid of [
  {revision_sha:'a'.repeat(40)},{state:'blocked'},
  {state:'revoked'},{worker_role:'hi5_release_executor_live'},
  {gateway_fence_tested:false},{restricted_role_tested:false},
  {customer_only_route_tested:false},{failure_compensation_tested:false},
  {public_version_verified:false},{audit_completion_tested:false},
  {reviewed_by:null},{reviewed_at:'2026-10-19T16:00:00Z'},
  {expires_at:'2026-10-19T14:00:00Z'},{reason:'short'},
  {evidence:{independentHostTest:true}},
  {evidence:{customerIsolationTest:true}},
 ]){
  assert.equal(reviewedExecutorCertification({...base,...invalid},SHA,now),false,
    JSON.stringify(invalid))
 }
 assert.equal(reviewedExecutorCertification(base,'notsha',now),false)
})

test('a deployment env switch cannot certify an unreviewed executor or unpinned revision',async()=>{
 const history=[]
 const pool={query:async(query,args)=>{
  history.push({query,args})
  return {rows:[base]}
 }}
 assert.equal(await certifiedRollbackExecutorReady(pool,{enabled:false,revisionSha:SHA,now}),false)
 assert.equal(await certifiedRollbackExecutorReady(pool,{enabled:true,revisionSha:'foo',now}),false)
 assert.equal(await certifiedRollbackExecutorReady(pool,{enabled:true,now}),false)
 assert.equal(history.length,0)
 assert.equal(await certifiedRollbackExecutorReady(pool,{enabled:true,revisionSha:SHA,now}),true)
 assert.equal(history.length,1)
 assert.deepEqual(history[0].args,[SHA])
 assert.match(history[0].query,/platform_release_customer_rollback_executor_certifications/)
 const missing={query:async()=>({rows:[]})}
 assert.equal(await certifiedRollbackExecutorReady(missing,{enabled:true,revisionSha:SHA,now}),false)
 const revoked={query:async()=>({rows:[{...base,state:'revoked'}]})}
 assert.equal(await certifiedRollbackExecutorReady(revoked,{enabled:true,revisionSha:SHA,now}),false)
})

test('migration is unseeded and no nonstaff identity can approve a worker by default',()=>{
 const sql=readFileSync(new URL('../migrations/platform-admin/178_independent_customer_rollback_executor_certification.sql',import.meta.url),'utf8')
 assert.match(sql,/CREATE TABLE platform_release_customer_rollback_executor_certifications/)
 assert.match(sql,/REVOKE ALL ON platform_release_customer_rollback_executor_certifications FROM PUBLIC/)
 assert.match(sql,/gateway_fence_tested AND restricted_role_tested/)
 assert.match(sql,/failure_compensation_tested/)
 assert.match(sql,/reviewed_by IS NOT NULL/)
 assert.match(sql,/independentHostTest/)
 assert.doesNotMatch(sql,/\bINSERT INTO\b|\bGRANT\s+(INSERT|UPDATE|ALL)\b/)
})

test('Live user API checks both certified revision and its feature switch',()=>{
 const api=readFileSync(new URL('../src/tenantRelease.js',import.meta.url),'utf8')
 const core=readFileSync(new URL('../src/customerProductionRollback.js',import.meta.url),'utf8')
 assert.match(api,/process\.env\.H5C_CUSTOMER_ROLLBACK_EXECUTOR_READY==='true'/)
 assert.match(api,/process\.env\.H5C_CUSTOMER_ROLLBACK_EXECUTOR_SHA\|\|null/)
 assert.match(core,/executorReady:admitted/)
 assert.match(core,/certifiedRollbackExecutorReady\(db/)
 assert.match(core,/executorRevisionSha/)
 assert.match(core,/upgrade hold is active/)
 assert.match(api,/Global hard-off until the independent host executor/)
})
