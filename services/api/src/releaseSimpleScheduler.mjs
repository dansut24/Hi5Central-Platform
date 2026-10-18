#!/usr/bin/env node
/**
 * One scheduler for customer ITSM release promotions.
 * Never launches Docker or changes Caddy. A published, certified SHA is
 * planned directly for Managed Production or Custom UAT; after customer
 * approval, Custom Production. Test is an independent Dev update stream.
 *
 * All generic stage grants, tenant-scope permission and maintenance-window
 * decisions remain enforced in fanoutCertifiedRelease and PostgreSQL.
 */
import pg from 'pg'
import {fanoutCertifiedRelease} from './certifiedReleaseFanout.js'
import {parsePinnedQaReleaseSha} from './releasePlannerScope.js'

const once=process.argv.includes('--once')
const preflight=process.argv.includes('--preflight')
if(process.argv.slice(2).some(v=>!['--once','--preflight'].includes(v)))
  throw Error('Usage: releaseSimpleScheduler.mjs [--once|--preflight]')
const pin=parsePinnedQaReleaseSha(process.env.RELEASE_BUILD_SHA)
const paused=process.env.RELEASE_SCHEDULER_ACTIVE!=='true'
const dbUrl=process.env.DATABASE_URL
if(!dbUrl||!/^postgres(?:ql)?:\/\//.test(dbUrl))
  throw Error('Dedicated release scheduler DATABASE_URL is required.')
const pool=new pg.Pool({connectionString:dbUrl,max:2,connectionTimeoutMillis:5000,
  idleTimeoutMillis:15000,application_name:'hi5central_release_scheduler'})
let run=true
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{run=false})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function checkIdentity(){
  const result=await pool.query('SELECT session_user,current_user')
  if(result.rows[0]?.session_user!=='hi5_release_planner'||
    result.rows[0]?.current_user!=='hi5_release_planner')
    throw Error('Refusing unrestricted or shared PostgreSQL credentials.')
}
async function cycle(){
  // Latest approved release ONLY. Never schedule an older certified build.
  const found=await pool.query([
    'SELECT c.build_sha FROM platform_certified_application_releases c',
    'JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
    "WHERE c.status='approved' AND c.approved_by IS NOT NULL",
    'AND ($1::text IS NULL OR c.build_sha=$1)',
    'ORDER BY n.published_at DESC,c.approved_at DESC LIMIT 1',
  ].join(' '),[pin])
  if(!found.rows.length){
    console.log(JSON.stringify({type:'no_certified_release'}));return
  }
  const client=await pool.connect()
  try{
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query("SET LOCAL statement_timeout='50s'")
    const result=await fanoutCertifiedRelease(client,{
      sha:found.rows[0].build_sha,scope:'generic',
      deliveryMode:'direct_customer_release',limit:100,
    })
    await client.query('COMMIT')
    console.log(JSON.stringify({type:'direct_customer_release_planned',...result}))
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{})
    throw error
  }finally{client.release()}
}
try{
  await checkIdentity()
  console.log(JSON.stringify({type:'scheduler_ready',
    latestOnly:!pin,pinnedSha:pin||null,active:!paused}))
  if(!preflight){
    do{
      if(!paused)try{await cycle()}catch(e){
        console.error('SCHEDULER_CYCLE_BLOCKED',String(e.message).slice(0,300))
        if(once)process.exitCode=1
      }
      if(run&&!once)await sleep(60000)
    }while(run&&!once)
  }
}finally{await pool.end()}
