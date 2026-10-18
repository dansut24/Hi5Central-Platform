#!/usr/bin/env node
/**
 * Durable release planner. Never runs Docker or changes a customer route.
 * Two independent instances can poll: an advisory xact lock and unique
 * tenant/environment/release identities make scans idempotent.
 */
import pg from 'pg'
import {fanoutCertifiedRelease} from './certifiedReleaseFanout.js'
import {parseQaReleaseTenantSlugs} from './releaseQaCohort.js'

// Prevent a QA-certified build from ever planning work outside the approved cohort.
const qaTenantSlugs=parseQaReleaseTenantSlugs(process.env.RELEASE_QA_TENANT_SLUGS)
const once=process.argv.includes('--once')
const verify=process.argv.includes('--preflight')
if(process.argv.slice(2).some(x=>!['--once','--preflight'].includes(x)))
  throw Error('Supported arguments: --once or --preflight')
const dbUrl=process.env.DATABASE_URL
if(!dbUrl||!/^postgres(?:ql)?:\/\//.test(dbUrl))
  throw Error('The shared control-plane DATABASE_URL is required.')
const pool=new pg.Pool({
  connectionString:dbUrl,max:3,idleTimeoutMillis:15000,
  connectionTimeoutMillis:5000,application_name:'hi5central_release_fanout',
})
let running=true
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{running=false})
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function assertDatabaseIdentity(){
  const result=await pool.query('SELECT session_user AS login,current_user AS role')
  if(result.rows[0]?.login!=='hi5_release_planner' ||
    result.rows[0]?.role!=='hi5_release_planner')
    throw Error('Planner refuses shared or unrestricted PostgreSQL credentials.')
}

async function assertSchema(){
 const rows=await pool.query([
 'SELECT',
 "to_regclass('public.platform_certified_application_releases') IS NOT NULL AS certified,",
 "to_regclass('public.platform_release_fanout_checkpoints') IS NOT NULL AS journal,",
 "to_regclass('public.tenant_release_rollout_jobs') IS NOT NULL AS jobs,",
 "to_regclass('public.platform_release_test_qa_gates') IS NOT NULL AS test_gate,",
 "to_regclass('public.platform_release_gateway_owners') IS NOT NULL AS gateway_lock,",
 "to_regclass('public.platform_release_canary_tenants') IS NOT NULL AS canary_cohort",
 ].join(' '))
 const state=rows.rows[0]
 if(Object.values(state).some(v=>v!==true))
   throw Error('Release planner schema incomplete; migrations 159, 162 and 163 are required.')
 return state
}
async function cycle(){
 const approvals=await pool.query([
  'SELECT c.build_sha,n.published_at,c.approved_at',
  'FROM platform_certified_application_releases c',
  'JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
  "WHERE c.status='approved' AND c.approved_at IS NOT NULL",
  'ORDER BY n.published_at ASC,c.build_sha ASC LIMIT 50',
 ].join(' '))
 for(const approval of approvals.rows){
  const client=await pool.connect()
  try{
   await client.query('BEGIN')
   await client.query("SET LOCAL lock_timeout='5000ms'")
   await client.query("SET LOCAL statement_timeout='60000ms'")
   const result=await fanoutCertifiedRelease(client,{
    sha:approval.build_sha,
    limit:Number(process.env.RELEASE_PLANNER_TENANT_BATCH||200),
    testSoakMinutes:Number(process.env.RELEASE_PLANNER_TEST_SOAK_MINUTES||30),
    qaTenantSlugs,
   })
   await client.query('COMMIT')
   if(result.queued||result.alreadyQueued)
     console.log(JSON.stringify({type:'release_fanout',...result}))
  }catch(error){
   await client.query('ROLLBACK').catch(()=>{})
   console.error(JSON.stringify({type:'release_planner_error',
    sha:approval.build_sha,error:String(error.message||error).slice(0,350)}))
   if(once)process.exitCode=1
  }finally{client.release()}
 }
 if(process.env.RELEASE_PLANNER_VERBOSE==='true')
   console.log(JSON.stringify({type:'release_planner_poll',count:approvals.rowCount}))
}
try{
 await assertDatabaseIdentity()
 await assertSchema()
 if(verify)console.log('RELEASE_PLANNER_PREFLIGHT_PASS qaTenants='+qaTenantSlugs.length)
 else{
  do{
   try{await cycle()}
   catch(error){
    console.error('RELEASE_PLANNER_CYCLE_ERROR',error.message)
    if(once){process.exitCode=1;break}
   }
   if(!once&&running)await delay(60000)
  }while(!once&&running)
 }
}finally{await pool.end()}
