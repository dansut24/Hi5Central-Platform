#!/usr/bin/env node
// Host-only operator entry point. No Docker or Caddy changes without BOTH
// --apply and a host-approved HI5_RUNTIME_ROUTE_APPLY_ENABLED=true switch.
// The source intent is signed by the release authority, not tenant browsers.
import {execFileSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync,renameSync,appendFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {runHostRouteTransaction} from '../../src/runtimeHostRouteTransaction.js'

const argv=process.argv.slice(2)
const arg=name=>{const i=argv.indexOf(name);return i===-1?null:argv[i+1]}
const apply=argv.includes('--apply')
const intentPath=arg('--intent'),sigPath=arg('--signature'),keyPath=arg('--public-key')
if(!intentPath||!sigPath||!keyPath)
 throw Error('Usage: runtime-route-apply --intent PLAN.json --signature PLAN.sig --public-key trusted.pem [--apply]')
const intent=JSON.parse(readFileSync(resolve(intentPath),'utf8'))
const signature=readFileSync(resolve(sigPath),'utf8').trim()
const publicKeyPem=readFileSync(resolve(keyPath),'utf8')
const enabled=apply&&process.env.HI5_RUNTIME_ROUTE_APPLY_ENABLED==='true'
if(apply&&!enabled)throw Error('Host automatic route activation is disabled. Use a dry-run first.')
const root='/opt/hi5central/deployment',caddyFile=root+'/Caddyfile'
const auditDir=root+'/runtime-route-audit'
const caddy='hi5central-web'
const name='route-'+intent.environment+'-'+intent.tenantSlug+'-'+intent.routeGeneration
const tmp=mkdtempSync(join(tmpdir(),'hi5-runtime-route-'))
const file=name+'.caddy'
const candidatePath='/config/'+file
const beforePath='/config/'+name+'.before.caddy'
const docker=(args,timeout=20000)=>execFileSync('docker',args,{encoding:'utf8',timeout,maxBuffer:2*1024*1024})
const ensureHostFile=()=>readFileSync(caddyFile,'utf8')
const writeAtomic=(target,source)=>{
 const next=target+'.runtime-next'
 writeFileSync(next,source,{mode:0o600})
 renameSync(next,target)
}
const copyToCaddy=(text,path)=>{
 const local=join(tmp,'Caddyfile')
 writeFileSync(local,text,{mode:0o600})
 docker(['cp',local,caddy+':'+path])
}
const inspectTarget=target=>{
 const name=target.split(':')[0]
 const rows=JSON.parse(docker(['inspect',name]))
 const row=rows[0]
 if(!row||row.State?.Status!=='running'||row.State?.Health?.Status!=='healthy'
  ||row.Config?.Labels?.['org.opencontainers.image.revision']!==intent.buildSha)
  throw Error('Target is not a healthy container on the signed immutable build: '+name)
 const gateway=JSON.parse(docker(['inspect',caddy]))[0]
 const gatewayNetworks=Object.keys(gateway.NetworkSettings.Networks||{})
 const targetNetworks=Object.keys(row.NetworkSettings.Networks||{})
 if(!targetNetworks.some(n=>gatewayNetworks.includes(n)))
  throw Error('Target is not reachable on the gateway Docker network: '+name)
 if(intent.environment!=='live'){
  const env=Object.fromEntries((row.Config?.Env||[]).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)]}))
  if(env.RUNTIME_ENVIRONMENT!==intent.environment||env.VERSIONED_POOL_TENANT_SLUG!==intent.tenantSlug)
   throw Error('The sandbox pool is not locked to the expected tenant and environment.')
 }
}
const getPublicSha=async path=>{
 const r=await fetch('https://'+intent.publicHost+path,{
  cache:'no-store',redirect:'error',headers:{Origin:'https://'+intent.publicHost},
  signal:AbortSignal.timeout(12000)})
 if(r.status!==200)throw Error('Public route verification failed: '+path+' HTTP '+r.status)
 const j=await r.json()
 return j.sha
}
const adapter={
 async readActiveConfig(){
  const saved=join(tmp,'active-caddy')
  docker(['cp',caddy+':/etc/caddy/Caddyfile',saved])
  const active=readFileSync(saved,'utf8')
  if(active!==ensureHostFile())
   throw Error('Caddy bind mount differs from startup configuration. Reconcile gateway drift first.')
  return active
 },
 async validateCandidate(candidate){
  copyToCaddy(candidate,candidatePath)
  docker(['exec',caddy,'caddy','validate','--config',candidatePath,'--adapter','caddyfile'])
 },
 async verifyTargetBuild(){
  inspectTarget(intent.nextApiTarget)
  inspectTarget(intent.nextUpstream)
 },
 async preserveRollback(previous){
  mkdirSync(auditDir,{recursive:true,mode:0o700})
  writeFileSync(join(auditDir,name+'.before'),previous,{mode:0o600,flag:'wx'})
  copyToCaddy(previous,beforePath)
 },
 async activateCandidate(candidate){
  writeAtomic(caddyFile,candidate)
  docker(['exec',caddy,'caddy','reload','--config',candidatePath,'--adapter','caddyfile'])
 },
 async verifyPublicRoute(){
  for(const path of ['/release-manifest.json','/api/v1/updates/version']){
   if(await getPublicSha(path)!==intent.buildSha)
    throw Error('The public customer route does not serve the signed release: '+path)
  }
  const login=await fetch('https://'+intent.publicHost+'/login',{
   cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)})
  if(login.status!==200)throw Error('Customer login failed after cutover.')
 },
 async recordActivation(_,preview){
  // Operator must separately attest this host's observed route and publish
  // the generation; a local receipt is NOT a trusted control-plane proof.
  appendFileSync(join(auditDir,'activated-local.jsonl'),JSON.stringify({
   timestamp:new Date().toISOString(),...preview,state:'host_verified_unattested'})+'\n',{mode:0o600})
 },
 async restoreRollback(previous){
  writeAtomic(caddyFile,previous)
  docker(['exec',caddy,'caddy','reload','--config',beforePath,'--adapter','caddyfile'])
 },
 async verifyRestoredRoute(){
  if(!intent.previousBuildSha)return
  for(const path of ['/release-manifest.json','/api/v1/updates/version']){
   if(await getPublicSha(path)!==intent.previousBuildSha)
    throw Error('Previous customer revision was not restored: '+path)
  }
 },
}
try{
 const result=await runHostRouteTransaction({
  intent,signature,publicKeyPem,adapter,applyEnabled:enabled,
 })
 // Do not emit signed files or credentials.
 console.log(JSON.stringify(result))
}finally{rmSync(tmp,{recursive:true,force:true})}
