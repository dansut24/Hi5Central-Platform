import test from 'node:test'
import assert from 'node:assert/strict'
import {
  reviewedJobRequest,jobSafeToCancel,jobSafeToRetry,registerReleaseWorkActivityRoutes,
} from '../src/releaseWorkActivity.js'

const jobId='11111111-1111-4111-8111-111111111111'
const tenantId='22222222-2222-4222-8222-222222222222'
const userId='33333333-3333-4333-8333-333333333333'
const buildSha='a'.repeat(40)
const reason='Reviewed staff intervention for an isolated release job after checking the global pause.'
const request=(action='cancel')=>({
  action,jobId,tenantSlug:'customer-one',environment:'uat',buildSha,reason,
  confirm:action==='cancel'?'CANCEL_UNCLAIMED_RELEASE_JOB':'RETRY_FAILED_RELEASE_JOB',
})
const baseJob={
  id:jobId,tenant_id:tenantId,slug:'customer-one',environment:'uat',build_sha:buildSha,
  status:'scheduled',attempt_count:0,max_attempts:3,lease_token:null,
  lease_expires_at:null,lease_fence:0,routed_generation:null,last_error:null,
}
const clone=x=>JSON.parse(JSON.stringify(x))

test('exact staff confirmation, slug, stage, SHA and job UUID required',()=>{
  assert.deepEqual(reviewedJobRequest(request(),'cancel'),{
    jobId,buildSha,environment:'uat',tenantSlug:'customer-one',reason,
  })
  for(const change of [
    {jobId:'1234'},{tenantSlug:'different/slug'},{environment:'dev'},
    {buildSha:'aabb'},{confirm:'YES'},{reason:'too short'},
  ])assert.throws(()=>reviewedJobRequest({...request(),...change},'cancel'))
  assert.throws(()=>reviewedJobRequest(request('retry'),'cancel'))
})
test('claimed, deferred-with-attempts, routed and leased jobs cannot be cancelled',()=>{
  assert.equal(jobSafeToCancel(baseJob),true)
  assert.equal(jobSafeToCancel({...baseJob,status:'deferred'}),true)
  for(const change of [{attempt_count:1},{lease_token:jobId},{lease_fence:1},
    {lease_expires_at:new Date()},{routed_generation:7},{status:'running'},{status:'succeeded'}])
    assert.equal(Boolean(jobSafeToCancel({...baseJob,...change})),false)
})
test('only an unleased, unrouted failed job is potentially retryable',()=>{
  const failed={...baseJob,status:'failed',attempt_count:3,lease_fence:3}
  assert.equal(jobSafeToRetry(failed),true)
  for(const change of [{status:'cancelled'},{status:'rolled_back'},{status:'scheduled'},
    {attempt_count:0},{routed_generation:4},{lease_token:jobId},{lease_expires_at:new Date()}])
    assert.equal(Boolean(jobSafeToRetry({...failed,...change})),false)
})
function harness(body,{
  job=baseJob,paused=true,running=0,member=true,admin=true,
  certified=false,published=false,approved=false,
}={}){
  const paths=new Map(),writes=[],audits=[]
  const app={get:(path,handler)=>paths.set('GET '+path,handler),
    post:(path,handler)=>paths.set('POST '+path,handler)}
  const db={query:async(sql,params=[])=>{
    writes.push({sql,params})
    if(sql.includes('FROM platform_release_rollout_control'))return {rows:[{paused,reason:'Held'}],rowCount:1}
    if(sql.includes("status='running'"))return {rows:[{count:running}],rowCount:1}
    if(sql.includes('SELECT j.*'))return {rows:job?[job]:[],rowCount:job?1:0}
    if(sql.includes('platform_certified_application_releases'))return {rowCount:Number(certified),rows:certified?[{}]:[]}
    if(sql.includes('hi5central_published_release_notes'))return {rowCount:Number(published),rows:published?[{}]:[]}
    if(sql.includes('platform_release_generic_stage_approvals'))return {rowCount:Number(approved),rows:approved?[{}]:[]}
    if(sql.includes('UPDATE tenant_release_rollout_jobs'))return {rowCount:1,rows:[{id:jobId}]}
    return {rowCount:1,rows:[]}
  }}
  const deps={
    pool:{query:async()=>({rowCount:member?1:0,rows:member?[{}]:[]})},
    requireAdmin:async()=>admin?{session:{user_id:userId,session_id:jobId}}:
      {error:{status:401,value:{error:'Authentication required'}}},
    WRITE_ROLES:new Set(['owner','admin']),
    deployment:{runtimeEnvironment:'live'},
    withTransaction:fn=>fn(db),
    audit:async(...args)=>{audits.push(args);if(args.at(-1)!==db)throw Error('Audit not in same transaction')},
  }
  registerReleaseWorkActivityRoutes(app,deps)
  const c={req:{json:async()=>body},
    json:(value,status=200)=>({status,value})}
  return {paths,c,writes,audits}
}
test('cannot cancel when staff is unauthenticated or not an active platform owner',async()=>{
  for(const flags of [{admin:false},{member:false}]){
    const h=harness(request(),flags)
    const out=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/action')(h.c)
    assert.equal(out.status,flags.admin===false?401:403)
    assert.equal(h.writes.length,0)
  }
})
test('global pause and no running jobs are mandatory for job mutations',async()=>{
  for(const flags of [{paused:false},{running:1}]){
    const h=harness(request(),flags)
    const out=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/action')(h.c)
    assert.equal(out.status,409)
    assert.equal(h.writes.some(w=>w.sql.includes('UPDATE tenant_release_rollout_jobs')),false)
    assert.equal(h.audits.length,0)
  }
})
test('one unclaimed job cancel writes event and audit in same transaction',async()=>{
  const h=harness(request())
  const out=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/action')(h.c)
  assert.equal(out.status,200)
  assert.equal(out.value.status,'cancelled')
  assert.equal(out.value.globallyPaused,true)
  assert.equal(out.value.routeChanges,0)
  assert.equal(h.writes.filter(w=>w.sql.includes('UPDATE tenant_release_rollout_jobs')).length,1)
  assert.equal(h.writes.filter(w=>w.sql.includes('INSERT INTO tenant_release_rollout_events')).length,1)
  assert.equal(h.audits.length,1)
  assert.equal(h.audits[0][2],'release.rollout_job_cancelled')
})
test('a mismatched customer cannot be cancelled even by staff',async()=>{
  const h=harness({...request(),tenantSlug:'another-customer'})
  const out=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/action')(h.c)
  assert.equal(out.status,409)
  assert.equal(h.writes.some(w=>w.sql.includes('UPDATE tenant_release_rollout_jobs')),false)
  assert.equal(h.audits.length,0)
})
test('retry remains blocked without certified/published/stage approved release',async()=>{
  const failed={...baseJob,status:'failed',attempt_count:2,lease_fence:2}
  for(const flags of [{},{certified:true},{certified:true,published:true}]){
    const h=harness(request('retry'),{job:failed,...flags})
    const out=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/action')(h.c)
    assert.equal(out.status,409)
    assert.equal(h.writes.some(w=>w.sql.includes('UPDATE tenant_release_rollout_jobs')),false)
  }
})
test('retry only schedules after all approvals and audits original failure',async()=>{
  const failed={...baseJob,status:'failed',attempt_count:2,lease_fence:2,last_error:'Stage startup failed'}
  const h=harness(request('retry'),{job:failed,certified:true,published:true,approved:true})
  const out=await h.paths.get('POST /api/platform/v1/releases/rollout-jobs/action')(h.c)
  assert.equal(out.status,200)
  assert.equal(out.value.status,'scheduled')
  assert.equal(out.value.globallyPaused,true)
  const scheduled=h.writes.find(w=>w.sql.includes('INSERT INTO tenant_release_rollout_events'))
  assert.equal(scheduled.params[4],'scheduled')
  assert.equal(JSON.parse(scheduled.params[6]).previousAttempts,2)
  assert.equal(JSON.parse(scheduled.params[6]).retryRequested,true)
  assert.equal(h.audits[0][2],'release.rollout_job_retry_scheduled')
})
