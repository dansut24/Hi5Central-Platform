import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {assessFleetResume,reviewedFleetResumeRequest} from '../src/releaseFleetResume.js'
import {registerReleaseWorkActivityRoutes} from '../src/releaseWorkActivity.js'

const SHA='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const OLD='27f2378adccc1a66a84bac5a28a08ebbad835d6b'
const JOB1='45e97005-f092-4bc4-ad7e-6074fb5aed30'
const JOB2='e262f072-1675-4d41-adea-899105631f70'
const PILOT='f5b3a32f-6018-4808-977a-1124cc4b1e6f'
const now=new Date('2026-10-19T10:00:00Z')
const maintenance={start:'02:00',end:'05:00',timezone:'Europe/London',days:['mon','tue','wed','thu','fri','sat','sun']}
const common={build_sha:SHA,status:'scheduled',attempt_count:0,lease_fence:0,
 lease_token:null,lease_expires_at:null,routed_generation:null,tenant_status:'active',
 tenant_admitted:true,maintenance_window:maintenance,blackout_periods:[],
 scheduled_at:'2026-10-20T01:00:00Z',expected_duration_minutes:15,
 approval_expires_at:'2026-10-22T07:04:29Z',approved_at:'2026-10-19T07:04:29Z',
 approved_by:'staff',planning_enabled:true,execution_enabled:true,approval_evidence:true}
const jobs=[
 {...common,id:JOB1,slug:'company',environment:'live',approval_environment:'live',
   update_mode:'hi5_managed',live_auto_promote:true,uat_auto_stage:false},
 {...common,id:JOB2,slug:'companycustom',environment:'uat',approval_environment:'uat',
   update_mode:'admin_controlled',live_auto_promote:false,uat_auto_stage:true},
]
const pilot={id:PILOT,build_sha:SHA,status:'rolled_back',update_mode:'hi5_managed',
 previous_build_sha:OLD,permit_state:'completed',has_verified:true,
 has_rollback:true,has_admin_audit:true,live_assignment_restored:true,
 previous_route_attested:true}
const release={build_sha:SHA,certification_status:'approved',certified_approved_by:'staff',
 published_at:'2026-10-19T07:04:29Z'}
const heartbeats=[
 {gateway:'live',state:'paused',last_poll_at:'2026-10-19T09:59:00Z'},
 {gateway:'uat',state:'idle',last_poll_at:'2026-10-19T09:59:00Z'},
]
const evidence=(patch={})=>({paused:true,running:0,permits:0,queued:jobs,
 release,pilot,heartbeats,now,...patch})
const request={
 confirm:'RESUME_VERIFIED_CUSTOMER_RELEASE_FLEET',buildSha:SHA,
 expectedJobIds:[JOB2,JOB1],
 reason:'Verified real customer production deployment and successful manual rollback; enable only the certified scheduled cohort.',
}

test('exact SHA, full cohort, reason and confirmation required',()=>{
 assert.deepEqual(reviewedFleetResumeRequest(request),{
   buildSha:SHA,expectedJobIds:[JOB1,JOB2].sort(),reason:request.reason,
 })
 for(const bad of [
   {confirm:'resume'},{buildSha:OLD.slice(0,12)},{expectedJobIds:[JOB1]},
   {expectedJobIds:[JOB1,JOB1]},{expectedJobIds:[JOB1,'invalid']},
   {reason:'short'},
 ])assert.throws(()=>reviewedFleetResumeRequest({...request,...bad}))
})

test('approved real rollback, live+uat, worker health and future windows permit resume',()=>{
 const result=assessFleetResume(evidence())
 assert.equal(result.canResume,true)
 assert.deepEqual(result.reasons,[])
 assert.equal(result.buildSha,SHA)
 assert.deepEqual(result.jobIds,[JOB1,JOB2])
 assert.equal(result.rollbackJobId,PILOT)
})

test('pauses, leases, terminal jobs, invalid approval and failed customer rollback cannot resume',()=>{
 const invalid=[
   {paused:false},{running:1},{permits:1},{queued:[jobs[0]]},
   {queued:[{...jobs[0],status:'running'},jobs[1]]},
   {queued:[{...jobs[0],attempt_count:1},jobs[1]]},
   {queued:[{...jobs[0],lease_fence:2},jobs[1]]},
   {queued:[{...jobs[0],routed_generation:1},jobs[1]]},
   {queued:[{...jobs[0],build_sha:OLD},jobs[1]]},
   {queued:[{...jobs[0],tenant_admitted:false},jobs[1]]},
   {queued:[{...jobs[0],tenant_status:'suspended'},jobs[1]]},
   {queued:[{...jobs[0],live_auto_promote:false},jobs[1]]},
   {queued:[jobs[0],{...jobs[1],uat_auto_stage:false}]},
   {queued:[jobs[0],{...jobs[1],live_auto_promote:true}]},
   {queued:[jobs[0],{...jobs[1],scheduled_at:'2026-10-19T07:30:00Z'}]},
   {queued:[jobs[0],{...jobs[1],approval_expires_at:'2026-10-19T12:00:00Z'}]},
   {queued:[jobs[0],{...jobs[1],blackout_periods:[{startsAt:'2026-10-20T00:00:00Z',endsAt:'2026-10-20T04:00:00Z'}]}]},
   {release:{...release,certification_status:'unapproved'}},
   {pilot:{...pilot,status:'succeeded'}},
   {pilot:{...pilot,has_verified:false}},
   {pilot:{...pilot,has_rollback:false}},
   {pilot:{...pilot,has_admin_audit:false}},
   {pilot:{...pilot,live_assignment_restored:false}},
   {pilot:{...pilot,previous_route_attested:false}},
   {pilot:{...pilot,permit_state:'armed'}},
   {heartbeats:[{...heartbeats[0],last_poll_at:'2026-10-19T09:40:00Z'},heartbeats[1]]},
 ]
 for(const fail of invalid){
   const actual=assessFleetResume(evidence(fail))
   assert.equal(actual.canResume,false,'Did not reject '+JSON.stringify(fail).slice(0,175))
   assert.ok(actual.reasons.length)
 }
})

test('all maintenance times are evaluated with their own timezone and duration',()=>{
 assert.equal(assessFleetResume(evidence({queued:[{...jobs[0],
   scheduled_at:'2026-10-20T03:55:00Z',expected_duration_minutes:15},jobs[1]]})).canResume,false)
})

test('Admin exposes guarded readiness, not blanket unpause, and audit is atomic',()=>{
 const api=readFileSync(new URL('../src/releaseWorkActivity.js',import.meta.url),'utf8')
 const client=readFileSync(new URL('../../../apps/admin/src/features/admin/ReleaseWorkActivity.jsx',import.meta.url),'utf8')
 assert.match(api,/readFleetResumeReadiness\(pool\)/)
 assert.match(api,/pg_advisory_xact_lock\(hashtext\('hi5central-release-claim'\),hashtext\('shared-gateway'\)\)/)
 assert.match(api,/readFleetResumeReadiness\(db\)/)
 assert.ok(api.includes('JSON.stringify(ready.jobIds)!==JSON.stringify(request.expectedJobIds)'))
 assert.match(api,/release\.fleet_resumed_after_managed_rollback/)
 assert.match(api,/WHERE singleton=true AND paused=true/)
 assert.match(api,/tenant_release_rollout_events/)
 assert.match(client,/Resume verified rollout/)
 assert.match(client,/expectedJobIds:evidence\.jobIds/)
 assert.match(client,/The previously rolled-back/)
})

function fakeRoute({member=true,staff=true,controlPaused=true,ready=true,change=1}={}){
 const paths=new Map(),log=[],audits=[]
 const app={get:(name,handler)=>paths.set('GET '+name,handler),
  post:(name,handler)=>paths.set('POST '+name,handler)}
 const db={query:async(sql,params)=>{
   log.push({sql,params})
   if(sql.includes('FROM platform_release_rollout_control'))
     return {rowCount:1,rows:[{paused:controlPaused}]}
   if(sql.includes("status='running'"))return {rowCount:1,rows:[{count:0}]}
   if(sql.includes('SET paused=false'))return {rowCount:change,rows:change?[{singleton:true}]:[]}
   return {rowCount:1,rows:[{}]}
 }}
 const deps={
   requireAdmin:async()=>staff?{session:{user_id:'a'.repeat(8)+'-aaaa-4aaa-aaaa-'+ 'a'.repeat(12)}}:
    {error:{status:401}},
   WRITE_ROLES:new Set(['owner','admin']),
   pool:{query:async()=>({rowCount:member?1:0,rows:member?[{}]:[]})},
   deployment:{runtimeEnvironment:'live'},
   withTransaction:fn=>fn(db),
   audit:async(...params)=>{audits.push(params);assert.equal(params.at(-1),db)},
 }
 registerReleaseWorkActivityRoutes(app,deps)
 return {handler:paths.get('POST /api/platform/v1/releases/rollout-jobs/resume'),log,audits,
  c:{req:{json:async()=>request},json:(body,status=200)=>({body,status})},
 }
}
test('unauthenticated and nonmember staff cannot attempt global activation',async()=>{
 for(const options of [{staff:false},{member:false}]){
   const h=fakeRoute(options)
   const result=await h.handler(h.c)
   assert.equal(result.status,options.staff===false?401:403)
   assert.equal(h.log.length,0)
   assert.equal(h.audits.length,0)
 }
})
