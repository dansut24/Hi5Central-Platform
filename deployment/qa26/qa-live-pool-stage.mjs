#!/usr/bin/env node
/**
 * QA-only staging of REAL Production API+frontend immutable images on one VPS.
 * Does not alter shared Caddy, database schema, tenant release jobs or routes.
 * Source is the existing running production API/web. Versions always pinned
 * and old Live containers remain running. All operations are reproducible.
 */
import {spawnSync} from 'node:child_process'

const SHA=process.argv[2]
if(!/^[a-f0-9]{40}$/.test(String(SHA||'')))
  throw Error('Usage: node deployment/qa26/qa-live-pool-stage.mjs <official-image-sha40>')
const OLD='2199e58a540ff912cccdbd137fdfbb9e8d48f3c5'
const name='hi5pool-live-qa-release-'+SHA.slice(0,12)
const network='hi5central'
const types=[{type:'api',source:'hi5central-api',name:name+'-api',port:3001,mem:'768m'},
  {type:'itsm',source:'hi5central-prod-itsm',name:name+'-web',port:80,mem:'256m'}]
const timeout=45000
function run(args,input,ms=timeout){
  const p=spawnSync('docker',args,{input,encoding:'utf8',timeout:ms,maxBuffer:1024*1024})
  if(p.status!==0)throw Error('docker '+args.slice(0,2).join(' ')+
    ' failed: '+String(p.stderr||p.stdout||'').slice(-350))
  return p.stdout.trim()
}
function inspect(name){
 const p=spawnSync('docker',['inspect',name],{encoding:'utf8',timeout})
 return p.status===0?JSON.parse(p.stdout)[0]:null
}
function clone(t,image){
 const source=inspect(t.source)
 if(!source?.State?.Running)throw Error('Existing shared Live source unavailable: '+t.source)
 if(source.Config?.Image!=='ghcr.io/dansut24/hi5central-platform-'+t.type+':sha-'+OLD)
   throw Error('Shared Production baseline changed; inspect before proceeding.')
 const existing=inspect(t.name)
 if(existing){
   if(existing.Config.Image!==image||existing.State.Health?.Status!=='healthy')
     throw Error('Previously created release container changed/unhealthy.')
   console.log('REUSED_HEALTHY_POOL',t.name)
   return
 }
 const args=['run','-d','--name',t.name,'--network',network,
   '--restart','unless-stopped','--memory',t.mem,'--pids-limit','300',
   '--security-opt','no-new-privileges:true','--log-opt','max-size=10m','--log-opt','max-file=3']
 if(source.Config.User)args.push('--user',source.Config.User)
 if(source.Config.WorkingDir)args.push('--workdir',source.Config.WorkingDir)
 for(const env of source.Config.Env||[]){
   if(env.startsWith('API_URL=')&&t.type==='itsm')continue
   if(env.startsWith('BACKGROUND_WORKERS_ENABLED=')&&t.type==='api')continue
   args.push('--env',env)
 }
 if(t.type==='api')args.push('--env','BACKGROUND_WORKERS_ENABLED=false')
 if(t.type==='itsm')args.push('--env','API_URL=same-origin')
 for(const mount of source.Mounts||[]){
   const mType=mount.Type
   if(!['volume','bind'].includes(mType))throw Error('Unexpected Live mount type '+mType)
   const mountArg=['type='+mType,'source='+(mType==='volume'?mount.Name:mount.Source),'target='+mount.Destination]
   if(!mount.RW)mountArg.push('readonly')
   args.push('--mount',mountArg.join(','))
 }
 run([...args,image],undefined,60000)
 console.log('STAGED',t.name)
}
async function healthy(name){
 for(let i=0;i<90;i++){
   const obj=inspect(name)
   if(obj?.State?.Health?.Status==='healthy')return
   if(!obj?.State?.Running||obj.State.Health?.Status==='unhealthy')
     throw Error('Candidate is not healthy: '+name)
   await new Promise(ok=>setTimeout(ok,1000))
 }
 throw Error('Candidate health never stabilized: '+name)
}
function http(url,{expectedJson=false}={}){
 const args=['run','--rm','--network',network,'curlimages/curl:8.11.1',
   '-fsS','--max-time','8',url]
 const body=run(args,undefined,35000)
 if(expectedJson)return JSON.parse(body)
 return body
}
for(const t of types){
 const image='ghcr.io/dansut24/hi5central-platform-'+t.type+':sha-'+SHA
 run(['pull',image],undefined,200000)
 const inspectImage=JSON.parse(run(['image','inspect',image]))[0]
 if(inspectImage.Config.Labels?.['org.opencontainers.image.revision']!==SHA)
   throw Error('Official image OCI revision label does not match requested SHA.')
 clone(t,image)
}
await Promise.all(types.map(t=>healthy(t.name)))
const api=http('http://'+name+'-api:3001/api/v1/updates/version',{expectedJson:true})
const manifest=http('http://'+name+'-web:80/release-manifest.json',{expectedJson:true})
const runtime=http('http://'+name+'-web:80/runtime-config.js')
if(api.sha!==SHA||manifest.sha!==SHA
  ||!runtime.includes('apiUrl: "" || window.location.origin'))
  throw Error('Real Live-versioned API/frontend/browser runtime revisions do not agree.')
const health=http('http://'+name+'-api:3001/health',{expectedJson:true})
if(health.status!=='ok'||health.postgres!=='ok'||health.redis!=='ok')
  throw Error('Candidate Live API does not pass connected PostgreSQL+Redis health.')
console.log('REAL_PRODUCTION_CANDIDATE_READY',SHA)
console.log('LIVE_API_DATABASE_CONNECTED',health.status)
console.log('VERSIONED_FRONTEND_SAME_ORIGIN',name+'-web')
console.log('NO_PUBLIC_GATEWAY_OR_CUSTOMER_ROUTE_CHANGED')
