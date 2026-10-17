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
import {verifyReleaseGatewaySourceAgreement} from '../../services/api/src/releaseGatewaySourceAgreement.js'

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
 const expectedRoles=['hi5_release_generic_planner',
  'hi5_release_generic_exec_test','hi5_release_generic_exec_uat',
  'hi5_release_generic_exec_live'];
 const roles=await p.query([
  'SELECT rolname,rolcanlogin,rolsuper,rolbypassrls',
  'FROM pg_roles WHERE rolname=ANY($1::text[])',
 ].join(' '),[expectedRoles]);
 const currentAssignments=await p.query([
  'SELECT t.slug,a.build_sha,a.generation',
  'FROM tenant_runtime_assignments a JOIN tenants t ON t.id=a.tenant_id',
  "WHERE a.environment='live' AND t.slug=ANY($1::text[])",
 ].join(' '),[tenants.rows.map(t=>t.slug)]);
 await p.query('ROLLBACK');
 console.log(JSON.stringify({paused,active,tenants:tenants.rows,
  migrations:result.rows,missingMigrations,expectedRoles,
  roles:roles.rows,currentAssignments:currentAssignments.rows}));
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
   qaTenants:control.tenants.length,restrictedDatabaseRoles:control.roles,
   liveAssignments:control.currentAssignments.length}
 if(control.paused!==true)gate.reasons.push('Fleet is not paused; maintenance safety review needed.')
 if(control.active!==0)gate.reasons.push('A release cutover is currently running.')
 if(control.migrations.some(row=>!row.installed))
  gate.reasons.push('Required customer-release tables are not all installed.')
 if(control.missingMigrations?.length)
  gate.reasons.push(control.missingMigrations.length+
   ' historical/new release migration ledger entries require reviewed reconciliation.')
 const healthyRoles=new Set((control.roles||[]).filter(
  r=>r.rolcanlogin&&!r.rolsuper&&!r.rolbypassrls).map(r=>r.rolname))
 const missingRoles=control.expectedRoles.filter(role=>!healthyRoles.has(role))
 if(missingRoles.length)
  gate.reasons.push('Dedicated LOGIN and non-bypass release roles not active: '+
   missingRoles.join(', ')+'.')
 if(control.currentAssignments.length!==control.tenants.length)
  gate.reasons.push('Live tenant baseline assignments missing for '+
   (control.tenants.length-control.currentAssignments.length)+' customer(s).')
 const mounted=await docker('exec','hi5central-web','cat','/etc/caddy/Caddyfile')
 const host=await docker('run','--rm','--network','none','--mount',
  'type=bind,source='+hostFile+',target=/gateway/Caddyfile,readonly',
  'busybox:1.36','cat','/gateway/Caddyfile')
 const adapted=await docker('exec','hi5central-web','caddy','adapt',
  '--config','/etc/caddy/Caddyfile','--adapter','caddyfile')
 const loaded=await docker('exec','hi5central-web','wget','-q','-O','-',
  'http://127.0.0.1:2019/config/')
 const mountedActive=verifyReleaseGatewaySourceAgreement({
  hostSource:mounted,mountedSource:mounted,
  adaptedRuntime:adapted,loadedRuntime:loaded,
 })
 gate.gateways={
  activeMountedSha256:hash(mounted),hostBindSourceSha256:hash(host),
  filesAgree:hash(mounted)===hash(host),
  loadedRoutesMatchMounted:mountedActive.loadedMatchesMounted,
  adaptedRuntimeSha256:mountedActive.sourceRuntimeSha256||null,
  loadedRuntimeSha256:mountedActive.activeRuntimeSha256||null,
  activeReleaseRouteBlocks:(mounted.match(/H5C_RELEASE_ROUTE_BEGIN/g)||[]).length,
  hostLegacyQaCanaryBlocks:(host.match(/# QA26 LIVE CANARY BEGIN/g)||[]).length,
 }
 if(!gate.gateways.filesAgree)
  gate.reasons.push('Host and active-mounted Caddyfile differ: never reload either automatically.')
 if(gate.gateways.loadedRoutesMatchMounted!==true)
  gate.reasons.push('Active Caddy admin runtime routes differ from mounted Caddyfile; preserve runtime-only routes.')
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
   result.apiSha=SHA.test(String(parsed?.sha||''))?parsed.sha:null
   result.apiJsonShaVerified=version.status===200&&result.apiSha!==null
   if(environment==='live'){
    const [manifest,frontend]=await Promise.all([
     fetch(url+'/release-manifest.json',{signal:AbortSignal.timeout(6500),redirect:'manual'}),
     fetch(url+'/runtime-config.js',{signal:AbortSignal.timeout(6500),redirect:'manual'}),
    ])
    let release=null
    if(manifest.ok){try{release=await manifest.json()}catch{}}
    result.frontendSha=SHA.test(String(release?.sha||''))?release.sha:null
    result.frontendManifestVerified=manifest.status===200
      &&result.frontendSha!==null&&frontend.status===200
    result.exactApiFrontendMatch=result.apiSha!==null&&result.apiSha===result.frontendSha
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
 const liveMismatch=gate.customers.filter(x=>x.environment==='live'
   &&x.exactApiFrontendMatch!==true)
 if(liveMismatch.length)
  gate.reasons.push(liveMismatch.length+
   ' Live customer(s) lack a matched immutable API and frontend build.')
 const unknownBaseline=control.currentAssignments.filter(
  x=>!SHA.test(String(x.build_sha||''))||!Number.isSafeInteger(Number(x.generation))
    ||Number(x.generation)<1)
 if(unknownBaseline.length)
  gate.reasons.push('At least one Live route assignment has an invalid baseline.')
 const boundary=await Promise.all(control.tenants.flatMap(t=>[
  ...(t.update_mode==='hi5_managed'?[{
    slug:t.slug,host:t.slug+'-uat.hi5central.com',kind:'managed_uat'}]:[]),
  {slug:t.slug,host:t.slug+'-rmm.hi5central.com',kind:'rmm_host'},
 ]).map(async x=>{
  try{
   const r=await fetch('https://'+x.host+'/',{
    signal:AbortSignal.timeout(5500),redirect:'manual'})
   return {...x,status:r.status}
  }catch(e){return {...x,status:0,error:String(e?.name||'unreachable')}}
 }))
 gate.controls.forbiddenHostResults=boundary
 const managedUat=boundary.filter(x=>x.kind==='managed_uat'&&x.status===200)
 if(managedUat.length)
  gate.reasons.push(managedUat.length+
   ' Managed UAT aliases publicly serve a frontend despite no UAT entitlement.')
 // This is deliberately only an exposure detector, not a tenant data
 // access check. Product entitlement queries remain authoritative.
 const rmmRows=await docker('exec','hi5central-certified-release-planner',
  'node','--input-type=module','-e',
  `import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try{const r=await p.query("SELECT t.slug,coalesce((s.modules->>'rmm')::boolean,false) AS entitled FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id WHERE t.slug=ANY($1::text[])",[${JSON.stringify(control.tenants.map(t=>t.slug))}]);console.log(JSON.stringify(r.rows))}
  finally{await p.end()}`)
 const rmm=new Map(JSON.parse(rmmRows.trim()).map(x=>[x.slug,x.entitled]))
 const unexpectedRmm=boundary.filter(x=>x.kind==='rmm_host'&&rmm.get(x.slug)===false
  &&x.status===200)
 if(unexpectedRmm.length)
  gate.reasons.push(unexpectedRmm.length+
   ' non-RMM tenants publicly serve an RMM alias frontend.')
 gate.status=gate.reasons.length?'blocked':'review_ready'
}catch(e){gate.reasons.push('Operator read-only inspection failed: '+String(e.message||e).slice(0,180))}
console.log(JSON.stringify(gate,null,2))
if(gate.status!=='review_ready')process.exitCode=2
