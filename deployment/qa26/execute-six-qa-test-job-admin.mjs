#!/usr/bin/env node
/**
 * Root-operator Test-only six-tenant rollout launcher. No automatic permit,
 * credential provisioning, global unpause or approval in this program.
 *
 *   node deployment/qa26/execute-six-qa-test-job-admin.mjs --check SLUG
 *   H5C_CANARY_REVIEWED_SHA=<audited git SHA> node ... --execute SLUG
 *
 * A separate valid 45-minute staff-approved EXACT JOB permit and restricted
 * DB credential must already exist. This cannot activate UAT or Production.
 */
import {execFileSync,spawnSync} from 'node:child_process'
import {statSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname,resolve} from 'node:path'
import {byQaTestSlug,qaTestBuildSha} from './single-test-canary/services/api/src/qaSixTestCohort.js'
import {activeTenantMaintenanceWindow} from '../../services/api/src/releaseRolloutPlanner.js'

const [mode,slug,...extra]=process.argv.slice(2)
if(extra.length||!['--check','--execute'].includes(mode))
  throw Error('Usage: --check|--execute <one reviewed QA Test tenant slug>')
const entry=byQaTestSlug(slug)
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
process.chdir(root)
const fail=message=>{throw Object.assign(new Error('QA_TEST_BLOCKED: '+message),{code:'QA_TEST_BLOCKED'})}
const exec=(cmd,args,timeout=25000)=>{
 const out=execFileSync(cmd,args,{encoding:'utf8',timeout,maxBuffer:1_500_000,
   stdio:['ignore','pipe','pipe']})
 return out.trim()
}
const select=String.raw`
const{Client}=require('pg')
;(async()=>{
const c=new Client({connectionString:process.env.DATABASE_URL})
await c.connect()
try{
 await c.query('BEGIN READ ONLY')
 const id=process.argv[1]
 const sha='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
 const g=(await c.query('SELECT paused FROM platform_release_rollout_control WHERE singleton=true')).rows[0]
 const j=(await c.query([
 'SELECT j.id,j.environment,j.build_sha,j.status,j.attempt_count,j.scheduled_at,',
 'j.expected_duration_minutes,t.slug,t.status AS tenant_status,',
 'p.update_mode,p.maintenance_window,p.blackout_periods,',
 'c.status AS certification,',
 "(SELECT count(*)::int FROM tenant_release_rollout_events e WHERE e.job_id=j.id AND e.event_type='verified' AND e.fence=j.lease_fence) AS verified_events",
 'FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id',
 'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
 'JOIN platform_certified_application_releases c ON c.build_sha=j.build_sha',
 'WHERE j.id=$1 AND j.build_sha=$2'
 ].join(' '),[id,sha])).rows[0]||null
 const permit=(await c.query([
 'SELECT p.state,p.not_before<=now() AS started,p.expires_at>now() AS valid,',
 'p.tenant_slug,p.build_sha,p.environment,',
 '(p.approved_by=c.approved_by AND c.status=\'approved\') AS approved',
 'FROM platform_release_single_test_canary_permits p',
 'JOIN platform_certified_application_releases c ON c.build_sha=p.build_sha',
 'WHERE p.job_id=$1'
 ].join(' '),[id])).rows[0]||null
 const active=(await c.query(
 "SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status='running' AND lease_expires_at>now()"
 )).rows[0].n
 console.log(JSON.stringify({paused:g?.paused,job:j,permit,otherRunning:active}))
 await c.query('ROLLBACK')
}finally{await c.end()}
})().catch(e=>{console.error('QA_TEST_STATE_READ_FAILED',e.code||'DB');process.exitCode=1})
`
let state
try{
  state=JSON.parse(exec('docker',['exec','hi5central-certified-release-planner',
    'node','-e',select,entry.id]))
}catch{fail('Cannot establish an authoritative read-only platform state')}
const j=state.job
if(!j||j.id!==entry.id||j.slug!==entry.slug||j.environment!=='test'||
  j.build_sha!==qaTestBuildSha||j.certification!=='approved'||
  j.tenant_status!=='active'||j.update_mode!==entry.mode||
  state.paused!==true)fail('Job identity, entitlement, certification or global pause changed')
if(!['scheduled','succeeded'].includes(j.status))fail('Job is not scheduled or verified')
const now=new Date()
const window=activeTenantMaintenanceWindow({policy:j.maintenance_window,
 blackouts:j.blackout_periods||[],durationMinutes:j.expected_duration_minutes,now})
let publicApi=null,publicWeb=null
try{
 const host='https://'+slug+'-test.hi5central.com'
 publicApi=JSON.parse(exec('curl',['-fsS','--max-time','12',host+'/api/v1/updates/version'])).sha
 publicWeb=JSON.parse(exec('curl',['-fsS','--max-time','12',host+'/release-manifest.json'])).sha
}catch{fail('Public Test API/ITSM version endpoints are unavailable')}
if(publicApi!==publicWeb)fail('Public Test API and frontend disagree')
const completed=j.status==='succeeded'&&j.verified_events===1&&
  publicApi===qaTestBuildSha
const eligible=j.status==='scheduled'&&j.attempt_count===0&&
  state.otherRunning===0&&j.scheduled_at&&new Date(j.scheduled_at)<=now&&
  window.allowed===true&&publicApi===entry.baseline&&
  state.permit?.state==='armed'&&state.permit?.started===true&&
  state.permit?.valid===true&&state.permit?.approved===true&&
  state.permit?.tenant_slug===slug&&
  state.permit?.environment==='test'&&state.permit?.build_sha===qaTestBuildSha
console.log(JSON.stringify({
  mode,tenant:slug,jobId:entry.id,updateMode:entry.mode,
  jobStatus:j.status,attempts:j.attempt_count,
  globalPause:state.paused,windowAllowed:window.allowed,
  windowReason:window.reason,publicApi,publicWeb,
  targetSha:qaTestBuildSha,permitReady:Boolean(state.permit?.valid&&state.permit?.state==='armed'),
  readyToExecute:eligible,alreadyVerified:completed
}))
if(mode==='--check')process.exit(0)
if(process.getuid?.()!==0)fail('Root operator on authorised VPS is required')
if(completed){console.log('QA_TEST_ALREADY_VERIFIED_NO_REPEAT');process.exit(0)}
if(!eligible)fail('Exact authorised Test window, staff permit or baseline unavailable')
// A privileged host may be able to run Docker, but it must NEVER use a
// provisioned canary database account with excess privileges. This read-only
// ACL check prevents an insecure DB provisioning script from being accepted.
const privilegeAudit=String.raw`
const{Client}=require('pg')
;(async()=>{
const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
try{
 await c.query('BEGIN READ ONLY')
 const q=await c.query([
 "WITH r AS (SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit",
 "FROM pg_roles WHERE rolname='hi5_release_qa_canary')",
 "SELECT EXISTS(SELECT 1 FROM r WHERE rolcanlogin AND NOT rolsuper",
 "AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit) AS role_safe,",
 "COALESCE((SELECT count(*)::int FROM pg_class c",
 "JOIN pg_namespace n ON n.oid=c.relnamespace,r",
 "WHERE c.relkind='S' AND n.nspname='public'",
 "AND has_sequence_privilege(r.oid,c.oid,'USAGE')),0) AS allowed_sequences,",
 "COALESCE((SELECT has_sequence_privilege(r.oid,",
 "'public.tenant_release_rollout_events_id_seq'::regclass,'USAGE') FROM r),false)",
 "AS event_sequence_allowed,",
 "COALESCE((SELECT has_table_privilege(r.oid,",
 "'platform_release_rollout_control'::regclass,'UPDATE') FROM r),false)",
 "AS can_unpause"
 ].join(' '))
 console.log(JSON.stringify(q.rows[0]))
 await c.query('ROLLBACK')
}finally{await c.end()}
})().catch(()=>process.exit(1))
`
let acl
try{
 acl=JSON.parse(exec('docker',['exec','hi5central-certified-release-planner',
  'node','-e',privilegeAudit],25000))
}catch{fail('Scoped DB privilege review could not be independently verified')}
if(acl.role_safe!==true||acl.allowed_sequences!==1||
  acl.event_sequence_allowed!==true||acl.can_unpause!==false)
 fail('Scoped DB role requires security approval; one rollout event sequence only')
const targetDate=entry.window==='afternoon'?'2026-10-16':'2026-10-17'
const targetStart=entry.window==='afternoon'?14:2
const targetEnd=entry.window==='afternoon'?21:4
const parts=new Intl.DateTimeFormat('en-GB',{
 timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',
 hour:'2-digit',hourCycle:'h23',
}).formatToParts(now)
const v=Object.fromEntries(parts.map(p=>[p.type,p.value]))
if(`${v.year}-${v.month}-${v.day}`!==targetDate||
  Number(v.hour)<targetStart||Number(v.hour)>=targetEnd)
 fail('Exact reviewed local calendar window has not started or has ended')
const reviewed=process.env.H5C_CANARY_REVIEWED_SHA
if(!/^[a-f0-9]{40}$/.test(reviewed||'')||
  exec('git',['rev-parse','HEAD'])!==reviewed)
 fail('Reviewed checkout does not match provided immutable commit SHA')
const image='hi5central-qa-six-test-worker:reviewed-'+reviewed.slice(0,12)
const labels=JSON.parse(exec('docker',['image','inspect',image,'--format','{{json .Config.Labels}}']))
if(labels['hi5central.qa.reviewed_source']!==reviewed||
  labels['hi5central.qa.test_cohort']!=='six-fixed-tenants-2026.10.15')
 fail('Six-Test immutable worker image identity mismatch')
for(const c of ['hi5pool-test-9f3cb1da7c27-api','hi5pool-test-9f3cb1da7c27-web'])
 if(exec('docker',['inspect',c,'--format','{{.State.Health.Status}}'])!=='healthy')
   fail('Certified staged Test application unhealthy')
const file='/etc/hi5central/qa-single-test-canary/database.url'
try{
 const dir=statSync('/etc/hi5central/qa-single-test-canary')
 const st=statSync(file)
 if(!st.isFile()||st.mode&0o077||st.uid!==0||dir.mode&0o077||
   dir.uid!==0)fail('Restricted host credential is not safe')
}catch{fail('Restricted host credential is missing or invalid')}
const original=exec('docker',['exec','hi5central-test-gateway',
  'sha256sum','/etc/caddy/Caddyfile']).split(/\s+/)[0]
if(original!=='a9bd98d8eab259ad9be31f269b1ebff212e0673dbef9187a06df7c16fca1ae50')
 fail('Test gateway source fingerprint changed since QA approval')
// Final execution is one ephemeral image, one exact permit, one certified job.
const args=['run','--rm','--name','h5c-qa-six-test-'+slug,
 '--network','hi5central','--read-only','--cap-drop','ALL',
 '--security-opt','no-new-privileges:true','--pids-limit','128','--memory','384m',
 '--tmpfs','/tmp:rw,nosuid,size=32m',
 '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
 '--mount','type=bind,source='+file+',target=/run/secrets/qa_canary_db_url,readonly',
 '-e','DATABASE_URL_FILE=/run/secrets/qa_canary_db_url',
 '-e','RELEASE_GATEWAY=test','-e','RELEASE_QA_TENANT_SLUGS='+slug,
 '-e','RELEASE_WORKER_ID=single-test-canary-20261016',
 '-e','H5C_SINGLE_TEST_CANARY_JOB_ID='+entry.id,
 image,'--once']
const launched=spawnSync('docker',args,{stdio:'inherit',timeout:9*60*1000})
if(launched.error||launched.status!==0)fail('One-shot canary failed; retain watchdog and inspect audit before retry')
const resultAudit=JSON.parse(exec('docker',['exec','hi5central-certified-release-planner','node','-e',
 String.raw`
const{Client}=require('pg')
;(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const id=process.argv[1];
const j=(await c.query("SELECT status,attempt_count,completed_at FROM tenant_release_rollout_jobs WHERE id=$1",[id])).rows[0];
const e=(await c.query("SELECT count(*)::int n FROM tenant_release_rollout_events WHERE job_id=$1 AND event_type='verified'",[id])).rows[0];
const p=(await c.query("SELECT state FROM platform_release_single_test_canary_permits WHERE job_id=$1",[id])).rows[0];
const g=(await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true")).rows[0];
console.log(JSON.stringify({job:j,events:e.n,permit:p?.state,paused:g?.paused}));
await c.end()})().catch(()=>process.exit(1))
`,entry.id]))
if(resultAudit.job?.status!=='succeeded'||resultAudit.events!==1||resultAudit.permit!=='completed'||
  resultAudit.paused!==true)fail('Post-execution durable verification failed')
const api=JSON.parse(exec('curl',['-fsS','--max-time','12',
 'https://'+slug+'-test.hi5central.com/api/v1/updates/version'])).sha
const web=JSON.parse(exec('curl',['-fsS','--max-time','12',
 'https://'+slug+'-test.hi5central.com/release-manifest.json'])).sha
if(api!==qaTestBuildSha||web!==qaTestBuildSha)
 fail('Public Test API/frontend attestation failed after committed job')
console.log(JSON.stringify({result:'QA_TEST_VERIFIED_SUCCESS',tenant:slug,
 job:entry.id,sha:qaTestBuildSha,globalPause:true}))
