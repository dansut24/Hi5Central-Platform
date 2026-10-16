import test from 'node:test'
import assert from 'node:assert/strict'
import {
  nextCustomerReleaseStage,scheduledCustomerRelease,
} from '../src/certifiedReleaseFanout.js'

const sha='a'.repeat(40),oldSha='b'.repeat(40)
const id='34f9f157-570b-4d86-a7e9-48fb013c0d11'
const now=new Date('2026-10-15T15:00:00Z')
const before='2026-10-15T13:00:00Z'
const completed='2026-10-15T14:00:00Z'
const tenant={
  id,status:'active',itsm:true,mode:'hi5_managed',
  testAutoSync:true,uatAutoStage:false,liveAutoPromote:true,
  liveDelayHours:24,
  maintenance:{timezone:'Europe/London',start:'14:00',end:'22:00',
    days:['mon','tue','wed','thu','fri','sat','sun']},
  blackouts:[],
}
const args={
  tenant,sha,publishedAt:before,approvedAt:before,now,
  jobs:[],testSoakMinutes:30,
}
const completedTest={environment:'test',build_sha:sha,status:'succeeded',
  completed_at:completed}
const completedUat={environment:'uat',build_sha:sha,status:'succeeded',
  completed_at:completed}

test('approved release schedules Test at a real maintenance window, not immediately',()=>{
  const decision=nextCustomerReleaseStage(args)
  assert.equal(decision.stage,'test')
  const planned=scheduledCustomerRelease({decision,tenant,sha,now})
  assert.equal(planned.status,'scheduled')
  assert.ok(new Date(planned.scheduledAt)>now)
  assert.equal(planned.stage,'test')
})

test('Managed does not create any UAT job, even with passing Test',()=>{
  const decision=nextCustomerReleaseStage({...args,jobs:[completedTest]})
  assert.equal(decision.stage,null)
  assert.match(decision.reason,/platform Test quality gate/)
})

test('Managed requires approved Test gate, THEN full delay in tenant timezone',()=>{
  const gate={state:'passed',build_sha:sha,passed_canary_count:2,passed_at:completed}
  const decision=nextCustomerReleaseStage({...args,jobs:[completedTest],gate})
  assert.equal(decision.stage,'live')
  const plan=scheduledCustomerRelease({decision,tenant,sha,now})
  assert.ok(plan.status==='scheduled')
  assert.ok(new Date(plan.scheduledAt).getTime()>=new Date(completed).getTime()+86400000)
})

test('Custom UAT is scheduled only after Test has succeeded and soaked',()=>{
  const custom={...tenant,mode:'admin_controlled',uatAutoStage:true,liveAutoPromote:false}
  assert.equal(nextCustomerReleaseStage({...args,tenant:custom}).stage,'test')
  assert.equal(nextCustomerReleaseStage({...args,tenant:custom,
    jobs:[{...completedTest,status:'running'}]}).stage,null)
  const decision=nextCustomerReleaseStage({...args,tenant:custom,jobs:[completedTest]})
  assert.equal(decision.stage,'uat')
  const plan=scheduledCustomerRelease({decision,tenant:custom,sha,now})
  assert.equal(plan.stage,'uat')
})

test('Custom Production blocks without matching UAT and separate signed-off scheduling',()=>{
  const custom={...tenant,mode:'admin_controlled',uatAutoStage:true,liveAutoPromote:false}
  const jobs=[completedTest,completedUat]
  let d=nextCustomerReleaseStage({...args,tenant:custom,jobs})
  assert.equal(d.stage,null)
  assert.match(d.reason,/UAT acceptance/)
  d=nextCustomerReleaseStage({...args,tenant:custom,jobs,
    uatOffer:{build_sha:oldSha,state:'uat_accepted',uat_accepted_at:completed,
      uat_accepted_by:id}})
  assert.equal(d.stage,null)
  const accepted={build_sha:sha,state:'uat_accepted',uat_accepted_at:completed,
    uat_accepted_by:id}
  d=nextCustomerReleaseStage({...args,tenant:custom,jobs,uatOffer:accepted})
  assert.equal(d.stage,null)
  assert.match(d.reason,/explicitly scheduled/)
  d=nextCustomerReleaseStage({...args,tenant:custom,jobs,uatOffer:accepted,
    liveOffer:{build_sha:sha,state:'scheduled',promotion_approved_at:completed,
      promotion_approved_by:id,maintenance_not_before:'2026-10-16T12:00:00Z'}})
  assert.equal(d.stage,'live')
  assert.ok(d.notBefore>=new Date('2026-10-16T12:00:00Z'))
})

test('Prevent duplicate stage plan for already completed release',()=>{
  const gate={state:'passed',build_sha:sha,passed_canary_count:2,passed_at:completed}
  const d=nextCustomerReleaseStage({...args,jobs:[completedTest,
    {environment:'live',build_sha:sha,status:'succeeded',completed_at:completed}],gate})
  assert.equal(d.stage,null)
})

test('RMM-only, disabled subscription and inactive tenants do not receive ITSM jobs',()=>{
  for(const t of [{...tenant,itsm:false},{...tenant,status:'suspended'}]){
    assert.equal(nextCustomerReleaseStage({...args,tenant:t}).stage,null)
  }
})

test('Blackout or window overrun blocks / reschedules rather than bypasses',()=>{
  const d=nextCustomerReleaseStage(args)
  const customBlackout={...tenant,blackouts:[{
    startsAt:'2026-10-15T00:00:00Z',endsAt:'2026-10-16T23:59:59Z',
  }]}
  const next=scheduledCustomerRelease({decision:d,tenant:customBlackout,sha,now})
  assert.equal(next.status,'scheduled')
  assert.ok(new Date(next.scheduledAt)>new Date('2026-10-16T23:59:59Z'))
  const tooShort={...tenant,maintenance:{...tenant.maintenance,
    start:'14:00',end:'14:05'}}
  const blocked=scheduledCustomerRelease({decision:d,tenant:tooShort,sha,now})
  assert.equal(blocked.status,'blocked')
})
