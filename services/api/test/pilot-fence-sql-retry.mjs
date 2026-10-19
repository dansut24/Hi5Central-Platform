import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {
 reviewedJobRequest,jobSafeToRetry,registerReleaseWorkActivityRoutes,
} from '../src/releaseWorkActivity.js'

const SHA='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const OLD='27f2378adccc1a66a84bac5a28a08ebbad835d6b'
const ID='f5b3a32f-6018-4808-977a-1124cc4b1e6f'
const who='33333333-3333-4333-8333-333333333333'
const tenant='22222222-2222-4222-8222-222222222222'
const err='Host version switch failed: TENANT_RELEASE_DEPLOYMENT_FAILED docker exec failed: ERROR: missing FROM-clause entry for table "j"'
const reason='Safe retry reviewed following corrected pilot fence SQL; old Production route independently verified.'
const job={id:ID,tenant_id:tenant,slug:'companymanaged',environment:'live',build_sha:SHA,
 status:'failed',attempt_count:1,max_attempts:3,lease_fence:1,
 lease_token:null,lease_expires_at:null,routed_generation:null,previous_build_sha:null,
 last_error:err}
const request={jobId:ID,environment:'live',tenantSlug:'companymanaged',buildSha:SHA,
 reason,action:'retry',confirm:'RETRY_FAILED_RELEASE_JOB'}

test('exact host SQL must keep job alias inside fenced EXISTS, not outside it',()=>{
 const src=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 const marker='  const query=['
 const first=src.indexOf(marker),last=src.indexOf("  ].join(' ')",first)
 assert.ok(first>0&&last>first)
 const expression='(['+src.slice(first+marker.length,last)+']).join(" ")'
 const query=runInNewContext(expression,{
   id:ID,token:'44444444-4444-4444-8444-444444444444',fence:1,
   environment:'live',sha:SHA,slug:'companymanaged',
 })
 assert.match(query,/AND \(\(SELECT paused=false/)
 assert.match(query,/pilot\.job_id=j\.id AND pilot\.tenant_id=j\.tenant_id/)
 assert.match(query,/j\.lease_expires_at>now\(\)/)
 assert.match(query,/THEN 'ALLOW' ELSE 'DENY' END$/)
 assert.equal((query.match(/\(/g)||[]).length,(query.match(/\)/g)||[]).length,
   'host permit SQL has equal opening/closing parentheses')
})

test('only failed unrouted exact job may be staff retried after a prewrite error',()=>{
 assert.equal(jobSafeToRetry(job),true)
 for(const patch of [{status:'running'},{status:'succeeded'},{lease_token:ID},
   {lease_expires_at:new Date()},{routed_generation:1},{attempt_count:0}]){
  assert.equal(jobSafeToRetry({...job,...patch}),false)
 }
})

function makeHarness({error=err,publicSha=OLD,assigned=OLD,attested=true,certified=true}={}){
 const paths=new Map(),calls=[],audits=[]
 const app={get:(name,fn)=>paths.set('GET '+name,fn),post:(name,fn)=>paths.set('POST '+name,fn)}
 const c={req:{json:async()=>request},json:(value,status=200)=>({value,status})}
 const db={query:async(sql,params=[])=>{
  calls.push({sql,params})
  if(sql.includes('FROM platform_release_rollout_control'))return {rowCount:1,rows:[{paused:true}]}
  if(sql.includes("status='running'"))return {rowCount:1,rows:[{count:0}]}
  if(sql.includes('SELECT j.*,t.slug'))return {rowCount:1,rows:[{...job,last_error:error}]}
  if(sql.includes('platform_certified_application_releases')
    ||sql.includes('hi5central_published_release_notes')
    ||sql.includes('platform_release_generic_stage_approvals'))
    return {rowCount:certified?1:0,rows:certified?[{}]:[]}
  if(sql.includes('FROM tenant_runtime_assignments'))
    return {rowCount:assigned?1:0,rows:assigned?[{build_sha:assigned}]:[]}
  if(sql.includes('FROM tenant_runtime_route_attestations'))
    return {rowCount:attested?1:0,rows:attested?[{}]:[]}
  if(sql.includes('UPDATE tenant_release_rollout_jobs'))
    return {rowCount:1,rows:[{id:ID}]}
  return {rowCount:0,rows:[]}
 }}
 registerReleaseWorkActivityRoutes(app,{
   pool:{query:async()=>({rowCount:1,rows:[{}]})},
   withTransaction:fn=>fn(db),audit:async(...args)=>audits.push(args),
   requireAdmin:async()=>({session:{user_id:who,session_id:ID}}),
   WRITE_ROLES:new Set(['owner','admin']),deployment:{runtimeEnvironment:'live'},
 })
 const initialFetch=globalThis.fetch
 globalThis.fetch=async url=>({
   ok:true,json:async()=>({sha:publicSha,environment:'live'})
 })
 return {handler:paths.get('POST /api/platform/v1/releases/rollout-jobs/action'),c,calls,audits,
   restoreFetch:()=>{globalThis.fetch=initialFetch}}
}
test('verified pre-gateway SQL failure can safely retry after public old-SHA proof and staff sign-off',async()=>{
 const h=makeHarness()
 try{
  const r=await h.handler(h.c)
  assert.equal(r.status,200)
  assert.equal(r.value.status,'scheduled')
  assert.equal(r.value.globallyPaused,true)
  const update=h.calls.find(x=>x.sql.includes("SET status='scheduled'"))
  assert.equal(update.params[1],OLD)
  assert.match(update.sql,/previous_build_sha=\$2/)
  assert.match(update.sql,/last_error=''/)
  assert.ok(h.calls.some(x=>x.sql.includes('platform_release_single_live_pilot_permits')
      &&x.sql.includes("state='revoked'")))
  assert.equal(h.audits.length,1)
  assert.equal(h.audits[0][4].preWritePilotRecovery,true)
 }finally{h.restoreFetch()}
})
test('wrong served sha, stale attestation or unrecognised failed work cannot be retried',async()=>{
 for(const flags of [
   {publicSha:'c'.repeat(40)},{attested:false},
   {assigned:null},{certified:false},
   {error:'Unknown gateway error'},
 ]){
  const h=makeHarness(flags)
  try{
   const result=await h.handler(h.c)
   assert.equal(result.status,409)
   assert.ok(!h.calls.some(x=>x.sql.includes("SET status='scheduled'")))
  }finally{h.restoreFetch()}
 }
})
test('staff may re-arm only previously revoked/completed permit; never overwrite an active one',()=>{
 const code=readFileSync(new URL('../src/releaseWorkActivity.js',import.meta.url),'utf8')
 assert.match(code,/ON CONFLICT \(job_id\) DO UPDATE SET/)
 assert.match(code,/platform_release_single_live_pilot_permits\.state IN \('revoked','completed'\)/)
 assert.match(code,/if\(entry\.rowCount!==1\)throw refuse/)
 assert.match(code,/preWritePilotRecovery/)
 assert.match(code,/globalPausePreserved:true/)
})
