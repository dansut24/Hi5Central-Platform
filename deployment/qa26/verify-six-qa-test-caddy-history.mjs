#!/usr/bin/env node
/**
 * Read-only Caddy source/active/public attestation from the original
 * before-first-cutover backup and EXACT durably successful QA Test jobs.
 * No route, role, permit, token or deployment mutation.
 */
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {qaTestEntries,qaTestBuildSha} from './single-test-canary/services/api/src/qaSixTestCohort.js'
import {prepareTenantCaddyRoute} from '../../services/api/src/tenantCaddyVersionRoutes.js'

const initialSha='a9bd98d8eab259ad9be31f269b1ebff212e0673dbef9187a06df7c16fca1ae50'
const backup='release-test-1792157542313-h5c-managed-qa26-test-hi5central-com'
const baselineShaBySlug=new Map(qaTestEntries().map(x=>[x.slug,x.baseline]))
const hash=s=>createHash('sha256').update(s).digest('hex')
const exec=(program,args,extra={})=>execFileSync(program,args,{
 encoding:'utf8',timeout:30000,maxBuffer:3_000_000,stdio:['pipe','pipe','pipe'],...extra,
})
const docker=(...args)=>exec('docker',args)
const baseline=docker('run','--rm','--network','none',
 '--mount','type=volume,source=hi5central_release_test_backups,target=/backup,readonly',
 'busybox:1.36','cat','/backup/'+backup+'.caddy')
if(hash(baseline)!==initialSha)
 throw Error('First Test cutover backup is absent or has an unexpected fingerprint')
const sql=String.raw`
const{Client}=require('pg')
;(async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL})
 await c.connect()
 try{
  await c.query('BEGIN READ ONLY')
  const sha='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
  const p=(await c.query('SELECT paused FROM platform_release_rollout_control WHERE singleton=true')).rows[0]
  const j=(await c.query([
   'SELECT j.id,j.build_sha,j.environment,j.status,j.attempt_count,j.lease_fence,',
   'j.completed_at,t.slug,',
   "(SELECT count(*)::int FROM tenant_release_rollout_events e WHERE e.job_id=j.id",
   "AND e.event_type='verified' AND e.fence=j.lease_fence) AS verified_events",
   'FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id',
   "WHERE j.build_sha=$1 AND j.environment='test' ORDER BY j.completed_at ASC,t.slug ASC",
  ].join(' '),[sha])).rows
  console.log(JSON.stringify({paused:p?.paused,jobs:j}))
  await c.query('ROLLBACK')
 }finally{await c.end()}
})().catch(()=>process.exit(1))
`
const state=JSON.parse(docker('exec','hi5central-certified-release-planner',
 'node','-e',sql))
if(state.paused!==true||state.jobs.length!==6)
 throw Error('Global customer release pause/cohort unexpected')
const jobsById=new Map(qaTestEntries().map(x=>[x.id,x]))
let expected=baseline
let completed=0
const completedSlugs=[]
const seen=new Set()
for(const j of state.jobs){
 const entry=jobsById.get(j.id)
 if(!entry||entry.slug!==j.slug||seen.has(j.slug)
  ||j.environment!=='test'||j.build_sha!==qaTestBuildSha)
  throw Error('Test job is not in the immutable six-tenant allowlist')
 seen.add(j.slug)
 if(j.status==='succeeded'){
  if(j.attempt_count!==1||j.verified_events!==1||!j.completed_at
   ||Number(j.lease_fence)!==1)
   throw Error('A succeeded Test job lacks exact fenced proof: '+j.slug)
  expected=prepareTenantCaddyRoute({config:expected,tenantSlug:j.slug,
    environment:'test',buildSha:qaTestBuildSha}).config
  completed++
  completedSlugs.push(j.slug)
 }else if(j.status!=='scheduled'||j.attempt_count!==0||j.completed_at!==null
   ||j.verified_events!==0)
   throw Error('Unexpected Test job state before next cutover: '+j.slug)
}
const actual=docker('exec','hi5central-test-gateway','cat','/etc/caddy/Caddyfile')
if(actual!==expected)
 throw Error('Test Caddy source differs from exact verified sequential tenant routes')
const canonical=value=>Array.isArray(value)?value.map(canonical):
 value&&typeof value==='object'?
 Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value
const adapted=JSON.parse(docker('exec','hi5central-test-gateway',
 'caddy','adapt','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'))
const active=JSON.parse(docker('exec','hi5central-test-gateway',
 'wget','-qO-','http://127.0.0.1:2019/config/'))
// Caddy records the path from which a config was loaded in its own
// logging encoder's hide[0]. After a reviewed route write, the host executor
// reloads /tmp/h5c-release-executor.Caddyfile while the durable source stays
// at /etc/caddy/Caddyfile. Only this exact provenance field may differ.
const sourcePath='/etc/caddy/Caddyfile'
const runtimePath='/tmp/h5c-release-executor.Caddyfile'
const sourceHide=adapted?.apps?.http?.servers?.srv0?.routes?.[0]
  ?.handle?.[0]?.routes?.[0]?.handle?.[2]?.hide
const runtimeHide=active?.apps?.http?.servers?.srv0?.routes?.[0]
  ?.handle?.[0]?.routes?.[0]?.handle?.[2]?.hide
if(Array.isArray(sourceHide)&&Array.isArray(runtimeHide)
  &&sourceHide.length===1&&runtimeHide.length===1
  &&sourceHide[0]===sourcePath&&runtimeHide[0]===runtimePath)
 runtimeHide[0]=sourcePath
if(JSON.stringify(canonical(adapted))!==JSON.stringify(canonical(active)))
 throw Error('Active Test gateway routes differ from reviewed source')
for(const j of state.jobs){
 const h='https://'+j.slug+'-test.hi5central.com'
 const api=JSON.parse(exec('curl',['-fsS','--max-time','10',h+'/api/v1/updates/version'])).sha
 const web=JSON.parse(exec('curl',['-fsS','--max-time','10',h+'/release-manifest.json'])).sha
 const wanted=j.status==='succeeded'?qaTestBuildSha:baselineShaBySlug.get(j.slug)
 if(api!==wanted||web!==wanted)
  throw Error('Public API/frontend version differs from durable route history: '+j.slug)
}
console.log(JSON.stringify({status:'QA_SIX_TEST_GATEWAY_HISTORY_VERIFIED',
 globalPaused:true,verifiedCompleted:completed,completedSlugs,remaining:6-completed,
 exactSourceSha256:hash(expected),activeSourceMatch:true,publicApiWebMatch:true}))
