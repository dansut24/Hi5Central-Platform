#!/usr/bin/env node
/**
 * READ-ONLY activation readiness for existing real Hi5Central tenants.
 * Does not migrate, grant approval, unpause, claim, reload Caddy or deploy.
 * Usage: node deployment/qa26/verify-generic-existing-tenant-readiness.mjs --stage uat --sha SHA40
 */
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const SHA=/^[a-f0-9]{40}$/
const args=process.argv.slice(2)
const take=key=>{const i=args.indexOf(key);return i>=0?args[i+1]:null}
const stage=take('--stage'),sha=take('--sha')
if(args.length!==4||!['test','uat','live'].includes(stage)||!SHA.test(String(sha||'')))
 throw Error('Expected --stage <test|uat|live> --sha <certified SHA40>')
const docker=(...a)=>execFileSync('docker',a,{encoding:'utf8',timeout:30000,
 maxBuffer:4000000,stdio:['ignore','pipe','pipe']}).trim()
const hash=s=>createHash('sha256').update(s).digest('hex')
const sql=[
 'SELECT json_build_object(',
 "'paused',(SELECT paused FROM platform_release_rollout_control WHERE singleton=true),",
 "'approvalSchema',to_regclass('public.platform_release_generic_stage_approvals') IS NOT NULL,",
 "'approval',(SELECT row_to_json(a) FROM (",
 'SELECT build_sha,environment,planning_enabled,execution_enabled,',
 'approved_at,expires_at FROM platform_release_generic_stage_approvals',
 "WHERE build_sha='"+sha+"' AND environment='"+stage+"' LIMIT 1) a),",
 "'jobs',(SELECT COALESCE(json_agg(row_to_json(j)),'[]'::json) FROM (",
 'SELECT t.slug,x.id,x.status,x.scheduled_at,x.attempt_count',
 'FROM tenant_release_rollout_jobs x',
 'JOIN tenants t ON t.id=x.tenant_id',
 "WHERE x.build_sha='"+sha+"' AND x.environment='"+stage+"'",
 'ORDER BY t.slug) j),',
 "'running',(SELECT count(*) FROM tenant_release_rollout_jobs WHERE status='running')",
 ')'
].join(' ')
const script=`
const{Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
try{await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='15000ms'");
const present=(await c.query("SELECT to_regclass('public.platform_release_generic_stage_approvals') AS table_name")).rows[0].table_name;
const q=present?SQL_WITH_APPROVAL:SQL_WITHOUT_APPROVAL;
const result=await c.query(q);
console.log(JSON.stringify(result.rows[0].json_build_object));
await c.query('ROLLBACK');
}finally{await c.end()}})().catch(e=>{console.error(e.message);process.exitCode=1});
`
const noApproval=sql.replace(
 "'approval',(SELECT row_to_json(a) FROM ( SELECT build_sha,environment,planning_enabled,execution_enabled, approved_at,expires_at FROM platform_release_generic_stage_approvals WHERE build_sha='"+sha+"' AND environment='"+stage+"' LIMIT 1) a),",
 "'approval',NULL,")
const queryText=script.replace('SQL_WITH_APPROVAL',JSON.stringify(sql))
 .replace('SQL_WITHOUT_APPROVAL',JSON.stringify(noApproval))
const data=JSON.parse(docker('exec','hi5central-certified-release-planner','node','-e',queryText))
const worker='hi5central-release-executor-'+stage
const imageInfo=JSON.parse(docker('inspect',worker))[0]
const activeImage=imageInfo.Config.Image
const activeScope=(imageInfo.Config.Env||[]).find(x=>x.startsWith('RELEASE_WORKER_SCOPE='))?.slice(21)||'qa'
const activeAck=(imageInfo.Config.Env||[]).some(x=>
 x==='RELEASE_GENERIC_WORKER_ACK=reviewed-stage-approval-only')
const allJobs=data.jobs||[]
const checks=[]
const add=(id,passed,details)=>checks.push({id,passed,details})
add('certifiedStageJobsPresent',allJobs.length>0,allJobs.length+' existing tenant job(s)')
add('globalPauseProtected',data.paused===true,'global rollout pause '+(data.paused?'enabled':'disabled'))
add('noActiveRollouts',Number(data.running)===0,Number(data.running)+' running jobs')
add('migration166Installed',data.approvalSchema===true,
 data.approvalSchema?'Stage approval schema installed':'Migration 166 not installed')
add('planningStageApproved',data.approval?.planning_enabled===true&&
 new Date(data.approval.expires_at)>new Date(),'Exact release/stage planning grant')
add('executionStageApproved',data.approval?.execution_enabled===true&&
 new Date(data.approval.expires_at)>new Date(),'Exact release/stage execution grant')
add('genericWorkerActive',activeScope==='generic'&&activeAck,
 'Worker scope: '+activeScope+' / source image: '+activeImage)
const preflights=[]
for(const job of allJobs.filter(x=>['scheduled','deferred'].includes(x.status))){
 try{
  const raw=docker('run','--rm','--network','none','--entrypoint','node',
   'hi5central-generic-release-executor:reviewed-e29451c63d6a','-e','console.log("staged")')
  // The actual source host preflight is executed from the reviewed checkout,
  // rather than the worker container, and never provides any lease/secret.
  const p=JSON.parse(execFileSync('node',[
   'deployment/qa26/tenant-release-host-executor.mjs',
   stage,job.slug,sha,'--preflight'],{encoding:'utf8',timeout:60000,
   stdio:['ignore','pipe','pipe']}))
  preflights.push({slug:job.slug,passed:p.status==='preflight_pass',
   host:p.host,sourceSha256:p.sourceSha256})
 }catch(e){preflights.push({slug:job.slug,passed:false,
  reason:String(e.message).slice(0,160)})}
}
add('gatewayPreflights',preflights.every(p=>p.passed),
 preflights.length+' pending jobs independently checked')
if(stage==='live'){
 const mounted=docker('exec','hi5central-web','cat','/etc/caddy/Caddyfile')
 const host=docker('run','--rm','--network','none',
  '--mount','type=bind,source=/opt/hi5central/deployment/Caddyfile,target=/readonly/Caddyfile,readonly',
  'busybox:1.36','cat','/readonly/Caddyfile')
 add('liveGatewaySourceMatches',hash(mounted)===hash(host),
  'mounted SHA256 '+hash(mounted)+'; host SHA256 '+hash(host))
}
const result={audit:'GENERIC_REAL_TENANT_READINESS',sha,stage,
 checkedAt:new Date().toISOString(),readOnly:true,ready:checks.every(x=>x.passed),
 checks,preflights,existingJobCount:allJobs.length,
 completedJobs:allJobs.filter(x=>x.status==='succeeded').length}
console.log(JSON.stringify(result,null,2))
if(!result.ready)process.exitCode=2
