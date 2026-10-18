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
await Promise.all(children.map(child=>new Promise(resolve=>{
 if(child.exitCode!==null||child.signalCode!==null)return resolve()
 child.once('exit',resolve)
 child.once('error',resolve)
})))
process.exitCode=code
