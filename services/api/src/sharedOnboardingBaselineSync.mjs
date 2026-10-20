/**
 * Shared signup/first-onboarding baseline synchroniser.
 * Runs inside the EXISTING deployment-worker service. It is not another
 * systemd service, GitHub workflow, gateway route or customer rollout job.
 * Uses the LIVE stage's SELECT-only release-executor database identity.
 * Customer-specific Production/UAT routes are never touched.
 */
import pg from 'pg'
import {promises as fs} from 'node:fs'
import {execFile as execFileCallback} from 'node:child_process'
import {promisify} from 'node:util'
import {sharedBaselineImages,replaceSharedBaselineImages} from './sharedOnboardingBaseline.js'

const execFile=promisify(execFileCallback)
const SHA=/^[a-f0-9]{40}$/
const runtime='/opt/hi5central/runtime'
const composePath=runtime+'/compose.yml'
const backupDir=runtime+'/.shared-onboarding-history'
const imageBase='ghcr.io/dansut24/hi5central-platform-'
const args=['compose','--env-file','.env','--env-file','dev.env']
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))

async function docker(...argv){
 const {stdout}=await execFile('docker',argv,{cwd:runtime,
  timeout:240000,maxBuffer:4*1024*1024})
 return stdout.trim()
}
async function shaOnHost(host,path){
 const response=await fetch('https://'+host+path,{
  redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)})
 if(!response.ok)throw Error('Public onboarding '+host+' not healthy: '+response.status)
 const data=await response.json()
 if(!SHA.test(String(data.sha||'')))throw Error('Public onboarding endpoint returned an invalid SHA.')
 return data.sha
}
async function assertHealthy(sha){
 for(let attempt=0;attempt<28;attempt++){
  try{
   for(const [svc,type] of [['hi5central-api-1','api'],['hi5central-itsm-1','itsm']]){
    const data=JSON.parse(await docker('inspect',svc))[0]
    if(data.Config.Image!==imageBase+type+':sha-'+sha
       ||data.State.Health?.Status!=='healthy')throw Error('Shared service '+svc+' is not healthy.')
   }
   for(const host of ['hi5central.com','newtest.hi5central.com']){
    if(await shaOnHost(host,'/api/v1/updates/version')!==sha
       ||await shaOnHost(host,'/release-manifest.json')!==sha)
      throw Error('Public onboarding version differs from certified release.')
   }
   return
  }catch(error){
   if(attempt===27)throw error
   await delay(2000)
  }
 }
}
async function queryEligible(pool){
 const result=await pool.query([
  'SELECT n.build_sha FROM platform_certified_application_releases c',
  'JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
  "WHERE c.status='approved' AND c.approved_by IS NOT NULL",
  'ORDER BY n.published_at DESC,c.approved_at DESC LIMIT 1',
 ].join(' '))
 const sha=result.rows[0]?.build_sha
 if(!SHA.test(String(sha||'')))return null
 // Avoid Docker container restarts while the normal runner owns a customer
 // gateway or is mid-upgrade. These are SELECT-accessible to stage identity.
 const active=await pool.query([
  '(SELECT count(*)::int FROM tenant_release_rollout_jobs',
  " WHERE status='running') AS running_upgrades,",
  '(SELECT count(*)::int FROM platform_release_gateway_owners) AS gateway_owners',
 ].join('SELECT '))
 if(Number(active.rows[0]?.running_upgrades)!==0
   ||Number(active.rows[0]?.gateway_owners)!==0)return null
 return sha
}
async function verifyImageRevision(kind,sha){
 const image=imageBase+kind+':sha-'+sha
 await docker('pull',image)
 const result=JSON.parse(await docker('image','inspect',image))[0]
 if(result?.Config?.Labels?.['org.opencontainers.image.revision']!==sha)
  throw Error('Shared signup image failed exact revision verification: '+kind)
}
export async function synchroniseSharedOnboardingBaseline({databaseUrl}={}){
 if(!/^postgres(?:ql)?:\/\//.test(String(databaseUrl||'')))
  throw Error('Shared onboarding sync requires a dedicated stage database identity.')
 const pool=new pg.Pool({connectionString:databaseUrl,max:1,
  connectionTimeoutMillis:5000,idleTimeoutMillis:15000,
  application_name:'h5c_shared_signup_baseline'})
 try{
  const identity=(await pool.query('SELECT session_user,current_user')).rows[0]
  if(identity?.session_user!=='hi5_release_executor_live'
    ||identity.current_user!=='hi5_release_executor_live')
    throw Error('Shared onboarding synchroniser refuses privileged database credentials.')
  const sha=await queryEligible(pool)
  if(!sha)return {status:'no_eligible_release_or_busy'}
  const before=await fs.readFile(composePath,'utf8')
  const paired=sharedBaselineImages(before)
  if(paired.api===sha)return {status:'current',sha}
  // Do not alter a drifted, independently modified Compose. This transaction
  // changes EXACTLY the two shared onboarding service image references.
  for(const [svc,kind] of [['hi5central-api-1','api'],['hi5central-itsm-1','itsm']]){
   const inspected=JSON.parse(await docker('inspect',svc))[0]
   if(inspected.Config.Image!==imageBase+kind+':sha-'+paired.api
     ||inspected.State.Health?.Status!=='healthy')
    throw Error('Shared onboarding runtime differs from reviewed baseline.')
  }
  await verifyImageRevision('api',sha)
  await verifyImageRevision('itsm',sha)
  const changed=replaceSharedBaselineImages(before,sha)
  if(!changed.changed)return {status:'current',sha}
  await fs.mkdir(backupDir,{recursive:true,mode:0o700})
  const backup=backupDir+'/compose.before-'+Date.now()+'-'+paired.api.slice(0,12)+'.yml'
  const temp=composePath+'.shared-onboarding-next'
  const now=await fs.readFile(composePath,'utf8')
  if(now!==before)throw Error('Compose changed during approved image preparation.')
  await fs.writeFile(backup,before,{mode:0o600,flag:'wx'})
  let installed=false
  try{
   await fs.writeFile(temp,changed.source,{mode:0o600,flag:'wx'})
   await fs.rename(temp,composePath)
   installed=true
   await docker(...args,'config','--quiet')
   await docker(...args,'up','-d','--no-deps','api','itsm')
   await assertHealthy(sha)
  }catch(error){
   await fs.rm(temp,{force:true}).catch(()=>{})
   if(installed){
    await fs.writeFile(composePath,before)
    await docker(...args,'up','-d','--no-deps','api','itsm')
    await assertHealthy(paired.api)
   }
   throw error
  }
  console.log('SHARED_SIGNUP_BASELINE_UPGRADED '+paired.api+' -> '+sha)
  return {status:'upgraded',sha,previousSha:paired.api}
 }finally{await pool.end()}
}
