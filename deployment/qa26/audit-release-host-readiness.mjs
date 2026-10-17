#!/usr/bin/env node
/**
 * READ-ONLY operator report for the single-action ITSM release cutover.
 * Does not install migrations, change Docker configuration, copy Caddyfiles,
 * claim jobs, publish releases or unpause the fleet.
 *
 * Run from an explicitly authorised VPS host that has Docker CLI access:
 * node deployment/qa26/audit-release-host-readiness.mjs
 */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'

if(process.argv.length!==2)throw Error('Audit accepts no mutation options.')
const limited=async(program,args,timeoutMs=18000)=>{
 return new Promise((resolve,reject)=>{
  const child=spawn(program,args,{stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='',done=false
  const timer=setTimeout(()=>{if(!done){done=true;child.kill('SIGKILL');reject(Error('Read-only audit command timed out.'))}},timeoutMs)
  child.stdout.on('data',chunk=>{
   stdout+=chunk
   if(stdout.length>1500000)child.kill('SIGKILL')
  })
  child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>3000)child.kill('SIGKILL')})
  child.on('error',error=>{if(!done){done=true;clearTimeout(timer);reject(error)}})
  child.on('close',code=>{
   clearTimeout(timer)
   if(done)return;done=true
   if(code!==0)return reject(Error('Read-only host check failed: '+stderr.slice(-250)))
   resolve(stdout)
  })
 })
}
const docker=(...args)=>limited('docker',args)
const hash=s=>createHash('sha256').update(s).digest('hex')
const SHA=/^[a-f0-9]{40}$/
const hostFile='/opt/hi5central/deployment/Caddyfile'
const controlQuery=`
import pg from 'pg';
const p=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:6000});
try{
 await p.query('BEGIN READ ONLY');
 const paused=(await p.query('SELECT paused FROM platform_release_rollout_control WHERE singleton=true')).rows[0]?.paused;
 const active=(await p.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status='running'")).rows[0]?.n;
 const tenants=await p.query([
  'SELECT t.slug,p.update_mode FROM tenants t',
  'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  'JOIN tenant_settings s ON s.tenant_id=t.id',
  "WHERE t.status='active' AND s.onboarding_completed_at IS NOT NULL",
  "AND COALESCE((s.modules->>'itsm')::boolean,false)=true",
  'ORDER BY t.slug'
 ].join(' '));
 const names=['platform_release_generic_stage_approvals',
  'platform_release_generic_scope_control',
  'tenant_release_customer_rollback_requests',
  'platform_release_preparation_drafts'];
 const result=await p.query("SELECT name,to_regclass('public.'||name) IS NOT NULL AS installed FROM unnest($1::text[]) AS items(name)",[names]);
 const expected=['155_app_release_executor_heartbeat.sql',
  '156_itsm_configuration_audit_value_summaries.sql',
  '157_itsm_configuration_promotions.sql','158_tenant_release_rollout_jobs.sql',
  '159_platform_release_test_qa_gates.sql','160_tenant_test_runtime_assignments.sql',
  '161_release_rollout_blackouts.sql','163_certified_release_fanout.sql',
  '164_automatic_verified_test_canaries.sql','165_single_paused_test_canary.sql',
  '166_generic_release_stage_approvals.sql','167_release_emergency_pause_least_privilege.sql',
  '168_verified_test_canary_gate_least_privilege.sql',
  '169_generic_release_tenant_scope.sql','170_customer_scoped_itsm_rollback.sql',
  '171_customer_release_preparation_drafts.sql'];
 const ledger=await p.query('SELECT version FROM schema_migrations WHERE version=ANY($1::text[])',[expected]);
 const applied=new Set(ledger.rows.map(x=>x.version));
 const missingMigrations=expected.filter(id=>!applied.has(id));
 await p.query('ROLLBACK');
 console.log(JSON.stringify({paused,active,tenants:tenants.rows,
  migrations:result.rows,missingMigrations}));
}finally{await p.end()}
`
const gate={
  status:'blocked',generatedAt:new Date().toISOString(),readOnly:true,
  controls:{},gateways:{},customers:[],reasons:[],
}
try{
 const data=await docker('exec','hi5central-certified-release-planner','node','--input-type=module','-e',controlQuery)
 const control=JSON.parse(data.trim())
 gate.controls={globallyPaused:control.paused,activeDeploymentJobs:control.active,
   migrations:control.migrations,missingMigrationLedger:control.missingMigrations,
   qaTenants:control.tenants.length}
 if(control.paused!==true)gate.reasons.push('Fleet is not paused; maintenance safety review needed.')
 if(control.active!==0)gate.reasons.push('A release cutover is currently running.')
 if(control.migrations.some(row=>!row.installed))
  gate.reasons.push('Required customer-release tables are not all installed.')
 if(control.missingMigrations?.length)
  gate.reasons.push(control.missingMigrations.length+
   ' historical/new release migration ledger entries require reviewed reconciliation.')
 const mounted=await docker('exec','hi5central-web','cat','/etc/caddy/Caddyfile')
 const host=await docker('run','--rm','--network','none','--mount',
  'type=bind,source='+hostFile+',target=/gateway/Caddyfile,readonly',
  'busybox:1.36','cat','/gateway/Caddyfile')
 gate.gateways={
  activeMountedSha256:hash(mounted),hostBindSourceSha256:hash(host),
  filesAgree:hash(mounted)===hash(host),
  activeReleaseRouteBlocks:(mounted.match(/H5C_RELEASE_ROUTE_BEGIN/g)||[]).length,
  hostLegacyQaCanaryBlocks:(host.match(/# QA26 LIVE CANARY BEGIN/g)||[]).length,
 }
 if(!gate.gateways.filesAgree)
  gate.reasons.push('Host and active-mounted Caddyfile differ: never reload either automatically.')
 const containers=['hi5central-release-executor-live','hi5central-release-executor-uat',
  'hi5central-release-executor-test']
 const mounts=await Promise.all(containers.map(async name=>{
  try{
   const s=await docker('inspect','--format','{{range .Mounts}}{{.Destination}}|{{end}}',name)
   return {name,unrestrictedDockerSocket:s.split('|').includes('/var/run/docker.sock')}
  }catch{return {name,missing:true}}
 }))
 gate.controls.existingWorkerMounts=mounts
 if(mounts.some(x=>x.unrestrictedDockerSocket))
  gate.reasons.push('Legacy executors still mount unrestricted Docker socket.')
 const check=async(slug,environment)=>{
  const hostname=slug+(environment==='live'?'':'-'+environment)+'.hi5central.com'
  const url='https://'+hostname
  const result={hostname,environment}
  try{
   const version=await fetch(url+'/api/v1/updates/version',{
    signal:AbortSignal.timeout(6500),redirect:'manual',headers:{accept:'application/json'}})
   const contentType=version.headers.get('content-type')||''
   const body=await version.text()
   let parsed=null
   if(contentType.includes('json')){try{parsed=JSON.parse(body)}catch{}}
   result.apiVersionHttp=version.status
   result.apiJsonShaVerified=version.status===200&&SHA.test(String(parsed?.sha||''))
   if(environment==='live'){
    const [manifest,frontend]=await Promise.all([
     fetch(url+'/release-manifest.json',{signal:AbortSignal.timeout(6500),redirect:'manual'}),
     fetch(url+'/runtime-config.js',{signal:AbortSignal.timeout(6500),redirect:'manual'}),
    ])
    let release=null
    if(manifest.ok){try{release=await manifest.json()}catch{}}
    result.frontendManifestVerified=manifest.status===200
      &&SHA.test(String(release?.sha||''))
      &&frontend.status===200
   }
  }catch(e){result.error=String(e?.name||'unreachable')}
  return result
 }
 const targets=control.tenants.flatMap(t=>
  (t.update_mode==='hi5_managed'?['live','test']:['live','uat','test'])
   .map(environment=>({slug:t.slug,environment})))
 gate.customers=await Promise.all(targets.map(x=>check(x.slug,x.environment)))
 const broken=gate.customers.filter(x=>!x.apiJsonShaVerified)
 if(broken.length)gate.reasons.push(broken.length+' of '+targets.length+
   ' customer endpoints have no verified same-origin API build.')
 gate.status=gate.reasons.length?'blocked':'review_ready'
}catch(e){gate.reasons.push('Operator read-only inspection failed: '+String(e.message||e).slice(0,180))}
console.log(JSON.stringify(gate,null,2))
if(gate.status!=='review_ready')process.exitCode=2
