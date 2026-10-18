import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {claimDueRollouts} from '../src/tenantReleaseQueue.js'
import {nextCustomerReleaseStage} from '../src/certifiedReleaseFanout.js'
const SHA='ff3795f7d1bc5d256ced5142b578c0897f57f6a7'
const now=new Date('2026-10-18T15:30:00Z')
const common={sha:SHA,publishedAt:'2026-10-18T14:00:00Z',
 approvedAt:'2026-10-18T14:01:00Z',now,deliveryMode:'direct_customer_release'}
const tenant={status:'active',itsm:true,liveAutoPromote:true,uatAutoStage:true}
test('Managed Production is direct: a Test job and soak are NOT mandatory',()=>{
 const result=nextCustomerReleaseStage({...common,tenant:{...tenant,mode:'hi5_managed'},jobs:[]})
 assert.equal(result.stage,'live')
 const disabled=nextCustomerReleaseStage({...common,
 tenant:{...tenant,mode:'hi5_managed',liveAutoPromote:false},jobs:[]})
 assert.equal(disabled.stage,null)
})
test('Custom must run UAT first, then exact approved Production offer',()=>{
 const custom={...tenant,mode:'admin_controlled'}
 const newRelease=nextCustomerReleaseStage({...common,tenant:custom})
 assert.equal(newRelease.stage,'uat')
 const jobs=[{environment:'uat',build_sha:SHA,status:'succeeded',completed_at:'2026-10-18T14:15:00Z'}]
 const beforeApproval=nextCustomerReleaseStage({...common,tenant:custom,jobs})
 assert.equal(beforeApproval.stage,null)
 const uatOffer={build_sha:SHA,state:'uat_accepted',
  uat_accepted_at:'2026-10-18T14:20:00Z',
  uat_accepted_by:'a3b7c45e-2c3a-436c-b949-007756224888'}
 const liveOffer={build_sha:SHA,state:'scheduled',
  promotion_approved_at:'2026-10-18T14:25:00Z',
  promotion_approved_by:'a3b7c45e-2c3a-436c-b949-007756224888',
  maintenance_not_before:'2026-10-18T14:30:00Z'}
 const approved=nextCustomerReleaseStage({...common,tenant:custom,
  jobs,uatOffer,liveOffer})
 assert.equal(approved.stage,'live')
 assert.equal(nextCustomerReleaseStage({...common,tenant:custom,
  jobs,uatOffer:{...uatOffer,build_sha:'a'.repeat(40)},liveOffer}).stage,null)
})
test('execution queue requires BOTH named stage and admitted ITSM tenant; optionally SHA pinned',async()=>{
 const calls=[]
 const db={async query(sql,params){
  calls.push([String(sql),params])
  if(String(sql).includes('SELECT paused,reason FROM platform_release_rollout_control'))
   return {rows:[{paused:false,reason:''}]}
  return {rows:[]}
 }}
 const result=await claimDueRollouts(db,{now,limit:1,environment:'live',
  genericTenantScope:true,buildSha:SHA})
 assert.deepEqual(result.claimed,[])
 const found=calls.find(([sql])=>sql.includes('FOR UPDATE OF j SKIP LOCKED'))
 assert(found)
 assert.match(found[0],/hi5_release_generic_tenant_permitted\(j.tenant_id\)/)
 assert.match(found[0],/j\.build_sha=\$5/)
 assert.match(found[0],/j\.environment=\$3/)
 assert.match(found[0],/a\.execution_enabled=true/)
 assert.equal(found[1][4],SHA)
 assert.deepEqual(found[1].slice(2,4),['live',null])
})
test('QA-only Test/canary gate is not a prerequisite for direct worker',()=>{
 const worker=readFileSync(new URL('../src/tenantReleaseExecutor.mjs',import.meta.url),'utf8')
 assert.match(worker,/RELEASE_DELIVERY_MODE!=='direct_customer_release'/)
 assert.match(worker,/genericTenantScope:true/)
 assert.match(worker,/hi5_release_generic_tenant_permitted/)
 assert.doesNotMatch(worker,/QA rollout tenant allowlist contains an invalid slug|assertQaReleaseTenantAllowed/)
 assert.doesNotMatch(worker,/The exact tenant Test release must be verified/)
 assert.doesNotMatch(worker,/Platform Test\/canary release approval is missing/)
 assert.match(worker,/Custom Production requires the matching, host-verified UAT deployment/)
 assert.match(worker,/real tenant-admin UAT approval/)
})
