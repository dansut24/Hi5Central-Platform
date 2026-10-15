#!/usr/bin/env node
/** Stage official API+Admin Centre audit build without changing any public URL. */
import {spawnSync} from 'node:child_process'
const sha=process.argv[2]
if(!/^[a-f0-9]{40}$/.test(String(sha||'')))
  throw Error('Usage: node qa-worker-admin-stage.mjs <official_sha>')
const network='hi5central'
const entries=[
 {kind:'api',from:'hi5central-admin-overview-preview-api-cc516180',
   to:'hi5central-qa-worker-audit-'+sha.slice(0,12)+'-api',mem:'768m'},
 {kind:'admin',from:'hi5central-admin-preview-cc516180',
   to:'hi5central-qa-worker-audit-'+sha.slice(0,12)+'-web',mem:'256m'},
]
const run=(args,input,timeout=120000)=>{
 const p=spawnSync('docker',args,{input,encoding:'utf8',timeout,maxBuffer:3*1024*1024})
 if(p.status!==0)throw Error('Docker staging: '+String(p.stderr||p.stdout||'').slice(-500))
 return p.stdout
}
const inspect=name=>{
 const p=spawnSync('docker',['inspect',name],{encoding:'utf8',timeout:20000})
 return p.status===0?JSON.parse(p.stdout)[0]:null
}
const get=(container,path)=>{
 const p=spawnSync('docker',['run','--rm','--network',network,
   'curlimages/curl:8.11.1','-sS','-o','/dev/null','-w','%{http_code}',
   '--max-time','8','-H','Origin: https://admin.hi5central.com',
   'http://'+container+path],{encoding:'utf8',timeout:30000})
 if(p.status!==0)throw Error('Internal audit endpoint unreachable.')
 return p.stdout.trim()
}
async function healthy(container){
 for(let i=0;i<85;i++){
   const s=inspect(container)?.State
   if(s?.Health?.Status==='healthy')return
   if(!s?.Running||s?.Health?.Status==='unhealthy')throw Error('Unhealthy staged '+container)
   await new Promise(done=>setTimeout(done,1000))
 }
 throw Error('Timed out staging '+container)
}
for(const item of entries){
 const image='ghcr.io/dansut24/hi5central-platform-'+item.kind+':sha-'+sha
 run(['pull',image],undefined,180000)
 const label=JSON.parse(run(['image','inspect',image]))[0].Config.Labels?.['org.opencontainers.image.revision']
 if(label!==sha)throw Error('Official '+item.kind+' immutable OCI image mismatch.')
 const prior=inspect(item.from)
 if(!prior?.State?.Running)throw Error('Admin baseline unavailable: '+item.from)
 const existing=inspect(item.to)
 if(existing){
   if(existing.Config.Image!==image||existing.State?.Health?.Status!=='healthy')
     throw Error('Previously staged audit image differs or unhealthy.')
   continue
 }
 const args=['run','-d','--name',item.to,'--network',network,
  '--restart','unless-stopped','--memory',item.mem,'--pids-limit','300',
  '--security-opt','no-new-privileges:true','--log-opt','max-size=10m',
  '--log-opt','max-file=3']
 if(prior.Config.User)args.push('--user',prior.Config.User)
 if(prior.Config.WorkingDir)args.push('--workdir',prior.Config.WorkingDir)
 for(const env of prior.Config.Env||[]){
   if(item.kind==='api'&&(
     env.startsWith('BACKGROUND_WORKERS_ENABLED=')
     ||env.startsWith('RELEASE_OPERATOR_TOKEN=')
     ||env.startsWith('RELEASE_OPERATOR_TOKEN_FILE=')))continue
   args.push('--env',env)
 }
 if(item.kind==='api'){
   args.push('--env','BACKGROUND_WORKERS_ENABLED=false')
   // Same read-only secret volume as the trusted host release publisher.
   args.push('--env','RELEASE_OPERATOR_TOKEN_FILE=/config/operator.token')
   if((prior.Mounts||[]).some(m=>m.Destination==='/config'))
     throw Error('Conflicting API mount at operator secret path.')
   args.push('--mount',
     'type=volume,source=hi5central-release-operator-config,target=/config,readonly')
 }
 for(const m of prior.Mounts||[]){
   if(!['volume','bind'].includes(m.Type))throw Error('Unexpected Admin baseline mount.')
   const source=m.Type==='volume'?m.Name:m.Source
   args.push('--mount',['type='+m.Type,'source='+source,'target='+m.Destination,
     ...(m.RW?[]:['readonly'])].join(','))
 }
 run([...args,image])
 console.log('STAGED',item.to)
}
await Promise.all(entries.map(e=>healthy(e.to)))
const api=entries[0].to,web=entries[1].to
if(get(api+':3001','/api/platform/v1/releases/worker-activity')!=='401')
 throw Error('Worker audit route must reject unauthenticated callers.')
if(get(api+':3001','/api/platform/v1/releases/certifications')!=='401')
 throw Error('Certification API must be protected for staff only.')
if(get(web+':80','/healthz')!=='200')
 throw Error('Candidate Admin Centre frontend healthcheck failed.')
const check=run(['exec',web,'sh','-c',
 "grep -r -l -m1 'Release worker activity' /srv/assets/*.js | head -1"])
if(!check.trim())throw Error('Audit UI is absent from built Admin frontend.')
console.log('REAL_ADMIN_API_AUDIT_DENIES_UNAUTHORISED_401')
console.log('REAL_ADMIN_UI_WORKER_ACTIVITY_ASSET_PRESENT')
console.log('ADMIN_AND_API_CANDIDATE_HEALTHY',sha)
console.log('NO_ADMIN_URL_OR_PRODUCTION_ROUTE_CHANGED')
