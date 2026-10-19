import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {planMaintenanceReschedule} from '../src/tenantMaintenanceReschedule.js'
import {activeTenantMaintenanceWindow} from '../src/releaseRolloutPlanner.js'

const build='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const old={days:['mon','tue','wed','thu','fri','sat','sun'],start:'21:15',end:'00:00',timezone:'Europe/London'}
const morning={...old,start:'09:30',end:'11:30'}
const now=new Date('2026-10-19T07:50:00Z') // 08:50 BST on Monday
const job={
 status:'scheduled',environment:'live',build_sha:build,attempt_count:0,
 lease_fence:0,lease_token:null,lease_expires_at:null,routed_generation:null,
 created_at:'2026-10-19T07:04:29Z',scheduled_at:'2026-10-19T20:15:00Z',
 expected_duration_minutes:15,
}
const pref={update_mode:'hi5_managed',live_auto_promote:true,test_auto_sync:true,
 uat_auto_stage:false,maintenance_window:morning,blackout_periods:[]}
const args={job,preference:pref,now,approvedAt:'2026-10-19T07:04:29Z',publishedAt:'2026-10-19T07:04:29Z'}

test('Managed 21:15 → morning edit moves the SAME queued SHA to next valid UK time',()=>{
 const result=planMaintenanceReschedule(args)
 assert.equal(result.allowed,true)
 assert.equal(result.changed,true)
 assert.equal(result.scheduledAt,'2026-10-19T08:30:00.000Z') // Monday 09:30 BST
 assert.equal(activeTenantMaintenanceWindow({policy:morning,now:result.scheduledAt,durationMinutes:15}).allowed,true)
 assert.equal(job.scheduled_at,'2026-10-19T20:15:00Z')
 assert.equal(job.build_sha,build)
})
test('Unchanged existing time does not create a duplicate schedule',()=>{
 const result=planMaintenanceReschedule({...args,preference:{...pref,maintenance_window:old}})
 assert.equal(result.allowed,true)
 assert.equal(result.changed,false)
})
test('Running, previously attempted, leased, routed and completed jobs never reschedule',()=>{
 for(const patch of [
  {status:'running'},{status:'succeeded'},{status:'failed'},{status:'cancelled'},
  {attempt_count:1},{lease_fence:1},{lease_token:'example'},
  {lease_expires_at:now},{routed_generation:1},
 ]){
  assert.equal(planMaintenanceReschedule({...args,job:{...job,...patch}}).allowed,false)
 }
})
test('Custom UAT is allowed; Custom Production needs exact UAT + Live customer approvals',()=>{
 const custom={...pref,update_mode:'admin_controlled',live_auto_promote:false,uat_auto_stage:true}
 const uat=planMaintenanceReschedule({...args,job:{...job,environment:'uat'},preference:custom})
 assert.equal(uat.allowed,true)
 const missing=planMaintenanceReschedule({...args,preference:custom})
 assert.equal(missing.allowed,false)
 const approved=planMaintenanceReschedule({...args,preference:custom,
   liveOffer:{build_sha:build,state:'scheduled',promotion_approved_by:'owner',
      promotion_approved_at:'2026-10-19T09:00:00Z',maintenance_not_before:'2026-10-20T07:00:00Z'},
   uatOffer:{build_sha:build,state:'uat_accepted',uat_accepted_by:'owner',
      uat_accepted_at:'2026-10-19T08:00:00Z'},
 })
 assert.equal(approved.allowed,true)
 assert.ok(new Date(approved.scheduledAt).getTime()>=new Date('2026-10-20T07:00:00Z').getTime())
})
test('Window shortened below cutover duration fails closed',()=>{
 const plan=planMaintenanceReschedule({...args,preference:{...pref,
   maintenance_window:{...morning,start:'09:30',end:'09:45'}}})
 assert.equal(plan.allowed,false)
})
test('Blackout or narrowed weekdays move the release to the next safe window',()=>{
 const blocked=planMaintenanceReschedule({...args,preference:{...pref,
   blackout_periods:[{startsAt:'2026-10-19T08:25:00Z',endsAt:'2026-10-19T10:50:00Z'}]}})
 assert.equal(blocked.allowed,true)
 assert.equal(blocked.scheduledAt,'2026-10-20T08:30:00.000Z')
 const tuesday=planMaintenanceReschedule({...args,preference:{...pref,
   maintenance_window:{...morning,days:['tue']}}})
 assert.equal(tuesday.allowed,true)
 assert.equal(tuesday.scheduledAt,'2026-10-20T08:30:00.000Z')
})
test('Scheduler reconciles older API saves, without creating new customer release jobs',()=>{
 const scheduler=readFileSync(new URL('../src/releaseSimpleScheduler.mjs',import.meta.url),'utf8')
 const service=readFileSync(new URL('../src/tenantMaintenanceReschedule.js',import.meta.url),'utf8')
 const route=readFileSync(new URL('../src/tenantRelease.js',import.meta.url),'utf8')
 const ui=readFileSync(new URL('../../../apps/itsm/src/features/settings/ProductionReleaseManagement.jsx',import.meta.url),'utf8')
 assert.match(scheduler,/reconcileChangedTenantMaintenanceWindows\(client\)/)
 assert.match(service,/p.updated_at>j.updated_at/)
 assert.match(service,/pg_advisory_xact_lock\(hashtext\('hi5central-release-claim'\),hashtext\('shared-gateway'\)\)/)
 assert.match(service,/attempt_count=0 AND j.lease_fence=0/)
 assert.match(service,/event_type,details/)
 assert.match(service,/'rescheduled'/)
 assert.match(route,/withTransaction\(async db=>/)
 assert.match(route,/maintenanceWindowChanged:windowChanged/)
 assert.match(route,/recordSecurityEvent\(\{/)
 assert.match(ui,/automatically reschedules any unstarted release jobs/)
 assert.match(ui,/Upcoming scheduled application releases/)
})
