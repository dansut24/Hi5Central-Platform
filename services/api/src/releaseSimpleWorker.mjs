#!/usr/bin/env node
/**
 * A single deployment-worker service supervises stage-restricted executors.
 * Each child uses its OWN least-privileged DB identity; there is no privileged
 * credential fallback. No extra Docker containers per stage are required.
 *
 * The underlying tenantReleaseExecutor performs tenant/stage policy checks,
 * an exclusive gateway lock, fenced job claim, route proof and rollback.
 */
import {spawn} from 'node:child_process'

const stages=['test','uat','live']
const preflight=process.argv.includes('--preflight')
if(process.argv.slice(2).some(v=>v!=='--preflight'))
  throw Error('Usage: releaseSimpleWorker.mjs [--preflight]')
const standby=process.env.RELEASE_WORKER_ACTIVE!=='true'
import {rollbackExecutorEnabledForStage} from './stageRollbackActivationPolicy.js'
import {synchroniseSharedOnboardingBaseline} from './sharedOnboardingBaselineSync.mjs'
const children=[]
let closing=false
let code=0
function urlFor(stage){
 const key='RELEASE_DATABASE_URL_'+stage.toUpperCase()
 const value=process.env[key]
 if(!value||!/^postgres(?:ql)?:\/\//.test(value))
   throw Error('A stage-specific database credential is required for '+stage+'.')
 return value
}
for(const stage of stages)urlFor(stage)
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{
  closing=true;for(const p of children)if(!p.killed)p.kill(sig)
})
for(const stage of stages){
 // Child processes must not receive the other stage's DB credentials.
 const childEnv={...process.env}
 for(const name of stages)
   delete childEnv['RELEASE_DATABASE_URL_'+name.toUpperCase()]
 childEnv.DATABASE_URL=urlFor(stage)
 childEnv.RELEASE_GATEWAY=stage
 childEnv.RELEASE_WORKER_STANDBY=standby?'true':'false'
 childEnv.RELEASE_WORKER_ID='simple-'+stage
 // Explicit stage allowlist keeps Production rollback off during the UAT pilot.
 childEnv.H5C_STAGE_ROLLBACK_EXECUTOR_ENABLED=rollbackExecutorEnabledForStage({
  stage,enabled:process.env.H5C_STAGE_ROLLBACK_EXECUTOR_ENABLED,
  stages:process.env.H5C_STAGE_ROLLBACK_ENABLED_STAGES,
 })?'true':'false'
 const child=spawn(process.execPath,
   ['services/api/src/tenantReleaseExecutor.mjs',...(preflight?['--preflight']:[])],
   {cwd:process.cwd(),stdio:'inherit',env:childEnv})
 children.push(child)
 child.on('error',e=>{
   console.error('STAGE_WORKER_START_FAILED',stage,String(e.message).slice(0,160))
   code=1;closing=true
   for(const other of children)if(other!==child&&!other.killed)other.kill('SIGTERM')
 })
 child.on('exit',(status,signal)=>{
   if(status!==0)code=1
   if(!closing&&!preflight){
     console.error('STAGE_WORKER_EXITED',stage,status,signal||'')
     closing=true;code=1
     for(const other of children)if(other!==child&&!other.killed)other.kill('SIGTERM')
   }
 })
}
// One new task within the EXISTING supervisor, not another runner/service.
// Reads only the latest published, certified, administrator-approved SHA;
// changes the shared signup API/web image pair, never customer routes.
const signupSyncEnabled=process.env.H5C_SHARED_ONBOARDING_BASELINE_SYNC_ENABLED==='true'
let signupSyncBusy=false
let signupSyncTimer=null
let signupSyncStart=null
async function reconcileSignupBaseline(){
 if(closing||signupSyncBusy)return
 signupSyncBusy=true
 try{
  const outcome=await synchroniseSharedOnboardingBaseline({
   databaseUrl:urlFor('live'),
  })
  if(outcome.status==='upgraded')
   console.log('CERTIFIED_SHARED_SIGNUP_BASELINE_UPDATED',outcome.sha)
 }catch(error){
  // A baseline failure must not terminate the stage-restricted rollout
  // workers or silently update an unrelated customer.
  console.error('SHARED_SIGNUP_BASELINE_RETRY',String(error.message||error).slice(0,280))
 }finally{signupSyncBusy=false}
}
if(signupSyncEnabled&&!preflight){
 signupSyncStart=setTimeout(reconcileSignupBaseline,12000)
 signupSyncTimer=setInterval(reconcileSignupBaseline,60000)
}
for(const signal of ['SIGINT','SIGTERM'])
 process.on(signal,()=>{
  if(signupSyncStart)clearTimeout(signupSyncStart)
  if(signupSyncTimer)clearInterval(signupSyncTimer)
 })
await Promise.all(children.map(child=>new Promise(resolve=>{
 if(child.exitCode!==null||child.signalCode!==null)return resolve()
 child.once('exit',resolve)
 child.once('error',resolve)
})))
process.exitCode=code
