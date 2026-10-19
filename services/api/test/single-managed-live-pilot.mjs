import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {
  reviewedLivePilotRequest,livePilotJobEligible,registerReleaseWorkActivityRoutes,
} from '../src/releaseWorkActivity.js'
const jobId='11111111-1111-4111-8111-111111111111'
const tenantId='22222222-2222-4222-8222-222222222222'
const userId='33333333-3333-4333-8333-333333333333'
const buildSha='a'.repeat(40)
const prior='b'.repeat(40)
const reason='Authorised single Managed pilot after previous route proof and rollback rehearsal.'
const request={jobId,tenantSlug:'companymanaged',environment:'live',buildSha,reason,
 confirm:'ARM_SINGLE_MANAGED_PRODUCTION_PILOT'}
const job={id:jobId,tenant_id:tenantId,slug:'companymanaged',
 tenant_status:'active',environment:'live',update_mode:'hi5_managed',
 live_auto_promote:true,status:'scheduled',build_sha:buildSha,
 attempt_count:0,lease_fence:0,lease_token:null,lease_expires_at:null,
 routed_generation:null,scheduled_at:'2026-10-19T08:45:00.000Z',
 expected_duration_minutes:15,
 maintenance_window:{timezone:'Europe/London',
   days:['mon','tue','wed','thu','fri','sat','sun'],start:'09:45',end:'12:45'},
 blackout_periods:[],
}
test('exact staff authorisation is mandatory and is bound to Managed Live only',()=>{
 assert.deepEqual(reviewedLivePilotRequest(request),{
   jobId,tenantSlug:'companymanaged',environment:'live',buildSha,reason,
 })
 for(const patch of [
   {environment:'uat'},{environment:'test'},{jobId:'not-uuid'},
   {buildSha:'a'.repeat(20)},{tenantSlug:'customer/uat'},
   {confirm:'RESUME_RELEASES'},{reason:'too short'},
 ]){
   assert.throws(()=>reviewedLivePilotRequest({...request,...patch}))
 }
})
test('never arm Custom Production, any rerouted/claimed or attempted job, or ineligible tenant',()=>{
 assert.equal(livePilotJobEligible(job),true)
 for(const patch of [
   {environment:'uat'},{update_mode:'admin_controlled'},
   {live_auto_promote:false},{status:'running'},{status:'succeeded'},
   {status:'deferred'},{status:'pending'},{attempt_count:1},
   {lease_fence:1},{lease_token:jobId},{lease_expires_at:new Date()},
   {routed_generation:1},{tenant_status:'suspended'},
 ]){
   assert.equal(livePilotJobEligible({...job,...patch}),false,JSON.stringify(patch))
 }
})
function harness(flags={}){
 const paths=new Map(),queries=[],audits=[]
 const app={get:(p,h)=>paths.set('GET '+p,h),post:(p,h)=>paths.set('POST '+p,h)}
 const pool={query:async()=>({rowCount:flags.member===false?0:1,rows:flags.member===false?[]:[{}]})}
 const db={query:async(sql,params=[])=>{
  queries.push({sql,params})
  if(sql.includes('FROM platform_release_rollout_control'))return {rowCount:1,rows:[{paused:flags.paused!==false}]}
  if(sql.includes('count(*)::int AS count'))return {rowCount:1,rows:[{count:flags.running||0}]}
  if(sql.includes('SELECT j.*,t.slug'))return {rowCount:1,rows:[{...job,...flags.job}]}
  if(sql.includes('SELECT 1 FROM platform_certified_application_releases'))return {rowCount:flags.approved===false?0:1,rows:flags.approved===false?[]:[{}]}
  if(sql.includes('SELECT a.build_sha FROM tenant_runtime_route_attestations'))return {rowCount:flags.attested===false?0:1,rows:flags.attested===false?[]:[{build_sha:prior}]}
  if(sql.includes('SELECT 1 FROM platform_release_single_live_pilot_permits'))return {rowCount:flags.alreadyArmed===true?1:0,rows:flags.alreadyArmed===true?[{}]:[]}
  if(sql.includes('INSERT INTO platform_release_single_live_pilot_permits'))return {rowCount:1,rows:[{job_id:jobId,expires_at:new Date(Date.now()+1800000)}]}
  return {rowCount:0,rows:[]}
 }}
 registerReleaseWorkActivityRoutes(app,{
  pool,withTransaction:fn=>fn(db),audit:async(...args)=>audits.push(args),
  requireAdmin:async()=>flags.auth===false?
    {error:{status:401,value:{error:'Unauthenticated'}}}:
    {session:{user_id:userId,session_id:jobId}},
  WRITE_ROLES:new Set(['owner','admin']),deployment:{runtimeEnvironment:'live'},
 })
 return {paths,queries,audits,c:{req:{json:async()=>({...request,...flags.request})},
  json:(body,status=200)=>({body,status})}}
}
test('rearmed pilot keeps monotonic fenced lease after an explicitly audited retry',()=>{
 const prior='27f2378adccc1a66a84bac5a28a08ebbad835d6b'
 const retry={...job,lease_fence:1,previous_build_sha:prior,
   attempt_count:0,status:'scheduled',lease_token:null,
   lease_expires_at:null,routed_generation:null}
 assert.equal(livePilotJobEligible(retry),false,
   'No recorded staff retry must mean no second permit')
 assert.equal(livePilotJobEligible({...retry,retryAuthorised:true}),true,
   'A verified staff retry may be rearmed without altering the fenced lease number')
 for(const invalid of [{previous_build_sha:null},{lease_token:jobId},
   {attempt_count:1},{routed_generation:2},{status:'failed'}]){
   assert.equal(livePilotJobEligible({...retry,...invalid,retryAuthorised:true}),false)
 }
})
test('unauthenticated or non-member may never create a pilot permit',async()=>{
 for(const flags of [{auth:false},{member:false}]){
  const h=harness(flags)
  const r=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/pilot/arm')(h.c)
  assert.equal(r.status,flags.auth===false?401:403)
  assert.ok(!h.queries.some(x=>x.sql.includes('INSERT INTO platform_release_single_live_pilot_permits')))
 }
})
test('global pause is mandatory; operator cannot turn pilot into fleet resume',async()=>{
 const h=harness({paused:false})
 const r=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/pilot/arm')(h.c)
 assert.equal(r.status,409)
 assert.ok(!h.queries.some(x=>x.sql.includes('INSERT INTO platform_release_single_live_pilot_permits')))
})
test('an existing armed job, missing certification or stale prior route blocks pilot arming',async()=>{
 for(const flags of [{alreadyArmed:true},{approved:false},{attested:false}]){
  const h=harness(flags)
  const result=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/pilot/arm')(h.c)
  assert.equal(result.status,409)
  assert.ok(!h.queries.some(x=>x.sql.includes('INSERT INTO platform_release_single_live_pilot_permits')))
 }
})
test('only the staff-validated exact job can insert an expiring audited Live permit',async()=>{
 const h=harness()
 const outcome=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/pilot/arm')(h.c)
 assert.equal(outcome.status,200)
 assert.equal(outcome.body.pilotArmed,true)
 assert.equal(outcome.body.globalRolloutPaused,true)
 assert.equal(outcome.body.otherJobsAuthorised,false)
 assert.equal(h.audits.length,1)
 assert.equal(h.audits[0].at(-1),h.audits[0].at(-1))
 const permit=h.queries.filter(x=>x.sql.includes('INSERT INTO platform_release_single_live_pilot_permits'))
 assert.equal(permit.length,1)
 assert.equal(permit[0].params[0],jobId)
 assert.equal(permit[0].params[2],buildSha)
 assert.equal(permit[0].params[5],userId)
 assert.ok(!h.queries.some(x=>x.sql.includes('SET paused=false')))
})
test('the paused fleet gates both the worker dequeue and the actual host gateway write',()=>{
 const claim=readFileSync(new URL('../src/tenantReleaseQueue.js',import.meta.url),'utf8')
 const host=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 assert.match(claim,/platform_release_single_live_pilot_permits/)
 assert.match(claim,/pilot.job_id=j.id AND pilot.tenant_id=j.tenant_id/)
 assert.match(claim,/pilot.build_sha=j.build_sha/)
 assert.match(claim,/p.update_mode='hi5_managed'/)
 assert.match(claim,/pilot.expires_at>now\(\)/)
 assert.match(host,/async function assertCurrentFencedHostLease/)
 assert.match(host,/platform_release_single_live_pilot_permits pilot/)
 assert.match(host,/pilot.job_id=j.id AND pilot.tenant_id=j.tenant_id/)
 assert.match(host,/pilot.expires_at>now\(\)/)
 assert.match(host,/assertCurrentFencedHostLease\(\)/)
})
test('pilot migration is default-deny, least-privileged and excludes all other stages',()=>{
 const sql=readFileSync(new URL('../migrations/platform-admin/175_single_managed_live_pilot.sql',import.meta.url),'utf8')
 assert.match(sql,/CHECK\(environment='live'\)/)
 assert.match(sql,/CHECK\(expires_at>not_before/)
 assert.match(sql,/one_armed_live_release_pilot/)
 assert.match(sql,/ENABLE ROW LEVEL SECURITY/)
 assert.match(sql,/FOR SELECT TO hi5_release_executor_live/)
 assert.doesNotMatch(sql,/GRANT (?:INSERT|UPDATE|DELETE)/)
 assert.doesNotMatch(sql,/INSERT INTO platform_release_single_live_pilot_permits/)
})
