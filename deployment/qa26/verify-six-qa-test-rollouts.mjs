#!/usr/bin/env node
/**
 * READ ONLY: official six-tenant QA Test release audit.
 * Run from the trusted VPS host. No DB credential is read or printed: the
 * existing planner executes a fixed SELECT using its own existing connection.
 * Usage: node deployment/qa26/verify-six-qa-test-rollouts.mjs
 *        node deployment/qa26/verify-six-qa-test-rollouts.mjs --expect-canaries
 *        node deployment/qa26/verify-six-qa-test-rollouts.mjs --expect-six
 */
import {execFileSync} from 'node:child_process'
const expectedSha='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
const expected=['custom1','custom2','h5c-custom-qa26','h5c-managed-qa26','managed1','managed2']
const canaries=['h5c-custom-qa26','h5c-managed-qa26']
const modes=new Set(['--snapshot','--expect-canaries','--expect-six'])
const mode=process.argv[2]||'--snapshot'
if(process.argv.length>3||!modes.has(mode))throw Error('Use --snapshot, --expect-canaries or --expect-six')
function run(program,args,timeout=20000){
  return execFileSync(program,args,{encoding:'utf8',timeout,maxBuffer:2500000,stdio:['ignore','pipe','pipe']})
}
const query=String.raw`
const{Client}=require("pg");
(async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});
 await c.connect();
 try{
  await c.query("BEGIN READ ONLY");
  const sha="9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0";
  const p=(await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true")).rows[0];
  const j=(await c.query([
   "SELECT t.slug,j.id,j.tenant_id,j.environment,j.status,j.build_sha,j.scheduled_at,",
   "j.attempt_count,j.lease_fence,j.routed_generation,j.completed_at,j.previous_build_sha,",
   "p.update_mode,p.maintenance_window,",
   "(SELECT count(*)::int FROM tenant_release_rollout_events e",
   "WHERE e.job_id=j.id AND e.event_type='verified' AND e.fence=j.lease_fence) AS verified_events,",
   "(SELECT count(*)::int FROM tenant_runtime_assignments a",
   "WHERE a.tenant_id=j.tenant_id AND a.environment='test' AND a.build_sha=j.build_sha) AS assignments",
   "FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id",
   "JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id",
   "WHERE j.build_sha=$1 AND j.environment='test' ORDER BY t.slug",
  ].join(" "),[sha])).rows;
  const cert=(await c.query("SELECT status,approved_at FROM platform_certified_application_releases WHERE build_sha=$1",[sha])).rows[0];
  const gate=(await c.query("SELECT state,passed_canary_count FROM platform_release_test_qa_gates WHERE build_sha=$1",[sha])).rows[0]||null;
  const running=(await c.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status='running' AND lease_expires_at>now()")).rows[0].n;
  console.log(JSON.stringify({paused:p?.paused,certification:cert?.status||'missing',gate,runningJobs:running,jobs:j}))
  await c.query("ROLLBACK")
 }finally{await c.end()}
})().catch(e=>{console.error('QA_AUDIT_DB_READ_FAILED',e.code||'QUERY');process.exit(1)})
`;
let state
try{
 const raw=run('docker',['exec','hi5central-certified-release-planner','node','-e',query],25000)
 state=JSON.parse(raw)
}catch(e){console.error('QA_SIX_AUDIT_FAILED: central read unavailable');process.exit(2)}
const reports=[]
const errors=[]
if(state.paused!==true)errors.push('Global rollout unexpectedly unpaused')
if(state.certification!=='approved')errors.push('Official release is not certified')
if(state.jobs.length!==6)errors.push('Expected exactly six Test jobs')
const found=state.jobs.map(j=>j.slug).sort()
if(JSON.stringify(found)!==JSON.stringify([...expected].sort()))
 errors.push('Test job cohort identity changed')
for(const slug of expected){
 const job=state.jobs.find(j=>j.slug===slug)
 let apiSha=null,webSha=null,httpOk=false
 try{
  const host='https://'+slug+'-test.hi5central.com'
  const api=JSON.parse(run('curl',['-fsS','--max-time','10',host+'/api/v1/updates/version']))
  const web=JSON.parse(run('curl',['-fsS','--max-time','10',host+'/release-manifest.json']))
  apiSha=api.sha
  webSha=web.sha
  httpOk=/^[a-f0-9]{40}$/.test(apiSha)&&apiSha===webSha
 }catch{
  errors.push(slug+': public API or frontend manifest unavailable')
 }
 const succeeded=job?.status==='succeeded'&&job.build_sha===expectedSha&&
  job.verified_events===1&&job.attempt_count>=1&&
  job.completed_at!==null&&Number(job.routed_generation)>0&&
  job.assignments===1&&apiSha===expectedSha&&webSha===expectedSha
 const coherent=job&&job.status==='succeeded'?succeeded:httpOk
 if(!coherent)errors.push(slug+': job or public version proof is inconsistent')
 if((mode==='--expect-canaries'&&canaries.includes(slug))||mode==='--expect-six'){
  if(!succeeded)errors.push(slug+': expected verified Test upgrade is not complete')
 }
 if(mode==='--expect-canaries'&&!canaries.includes(slug)&&job?.status!=='scheduled')
  errors.push(slug+': non-canary job changed before its permitted window')
 reports.push({
  tenant:slug,policy:job?.update_mode,jobStatus:job?.status,
  scheduledAt:job?.scheduled_at,attempts:job?.attempt_count,
  verifiedEvents:job?.verified_events,assignmentCount:job?.assignments,
  publicApiSha:apiSha,publicWebSha:webSha,publicMatch:httpOk,
  targetInstalled:apiSha===expectedSha&&webSha===expectedSha,
  verifiedUpgrade:succeeded
 })
}
const result={
 audit:'QA_SIX_TEST_ROLLOUT',
 checkedAt:new Date().toISOString(),
 release:expectedSha,
 globalRolloutPaused:state.paused,
 certified:state.certification,
 gate:state.gate,
 runningJobs:state.runningJobs,
 mode,
 completed:reports.filter(r=>r.verifiedUpgrade).length,
 total:6,
 passed:errors.length===0,
 reports,
 errors,
}
console.log(JSON.stringify(result,null,2))
if(errors.length)process.exitCode=1
