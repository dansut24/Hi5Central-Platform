#!/usr/bin/env node
// Read-only preflight for the TWO EXISTING shared ITSM Test/UAT pools.
// Never starts containers, deploys images, reads secret values or creates tenants.
import fs from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

const dir=process.env.HI5_DEPLOY_DIR || '/workspace/hi5central-deploy'
const issues=[]
const notes=[]
const check=(ok,pass,fail)=>{if(ok)notes.push('PASS '+pass);else issues.push('BLOCKED '+fail)}
const getDockerJson=(args)=>JSON.parse(execFileSync('docker',args,{encoding:'utf8',maxBuffer:15_000_000}))
const manifest=(filename)=>{
  const file=path.join(dir,filename)
  if(!fs.existsSync(file))throw Error('Missing durable manifest: '+file)
  const source=fs.readFileSync(file,'utf8')
  const image=(service)=>{
    const escaped=service.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')
    const match=new RegExp('^  '+escaped+':\\s*\\n    image: ([^\\s]+)','m').exec(source)
    if(!match)throw Error('Missing image pin for '+service+' in '+file)
    return match[1]
  }
  if((source.match(/^  (?:control-server|itsm-web):/gm)||[]).length!==2 ||
     (source.match(/^    image:/gm)||[]).length!==2)
    throw Error('Unexpected image-lock structure: '+file)
  return {'control-server':image('control-server'),'itsm-web':image('itsm-web')}
}
let current,candidate
try{current=manifest('compose.qa26-sandbox-current-pins.yml');candidate=manifest('compose.qa26-sandbox-pr69-pins.yml')}
catch(e){issues.push('BLOCKED '+e.message)}
const runtimeFile=path.join(dir,'compose.qa26-sandbox-runtime-policy.yml')
check(fs.existsSync(runtimeFile)&&/BACKGROUND_WORKERS_ENABLED:\s*["']false["']/.test(fs.existsSync(runtimeFile)?fs.readFileSync(runtimeFile,'utf8'):''),
 'Permanent Test/UAT worker-disable policy exists','Missing shared sandbox worker-disable policy')
const baseFiles=[
 'compose.yml','compose.managed-edge.yml',
 '/workspace/phase42-sandbox-releases-mobile/compose.sandbox-itsm.yml',
 '/workspace/phase40-sandbox-native-login/compose.sandbox.yml'
]
for(const f of baseFiles){
 const abs=path.isAbsolute(f)?f:path.join(dir,f)
 check(fs.existsSync(abs),'Existing Compose layer: '+path.basename(abs),'Missing Compose layer: '+abs)
}
for(const env of ['test','uat']){
 const policy=env==='test'?'compose.portal-auth-85eb7daa.yml':'compose.customer-lifecycle-21d0a43.yml'
 check(fs.existsSync(path.join(dir,policy)),'Existing '+env+' policy layer','Missing '+env+' policy layer: '+policy)
 for(const service of ['control-server','itsm-web']){
  const name='hi5central-'+env+'-'+service+'-1'
  try{
   const c=getDockerJson(['inspect',name])[0]
   const vars=Object.fromEntries((c.Config.Env||[]).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]))
   const portBindings=c.HostConfig.PortBindings||{}
   check(c.State.Running && c.State.Health?.Status==='healthy',name+' healthy',name+' not healthy')
   check(!current || c.Config.Image===current[service],name+' matches permanent rollback pin',name+' differs from rollback pin')
   check(Object.keys(portBindings).length===0,name+' has no published ports',name+' unexpectedly publishes ports')
   check(Object.keys(c.NetworkSettings.Networks).includes('hi5central-'+env+'_hi5internal'),
     name+' on existing '+env+' network',name+' network mismatch')
   check(vars.RUNTIME_ENVIRONMENT===env,name+' runtime '+env,name+' incorrect runtime marker')
   if(service==='control-server'){
    const destinations=new Set(c.Mounts.map(m=>m.Destination))
    const expected=['/run/secrets','/srv/app-portal-packages','/srv/tenant-installers']
    check(expected.every(x=>destinations.has(x)),name+' reuses existing mounts',name+' mounts missing')
    check(['DATABASE_URL','ENV_IDENTITY_API_URL','ENV_IDENTITY_SHARED_SECRET_FILE'].every(x=>x in vars),
      name+' identity/DB settings present (values withheld)',name+' missing an identity/DB setting')
    check(!('QA26_STAGING_MODE' in vars)||vars.QA26_STAGING_MODE!=='true',
      name+' is a shared pool (not QA-only sidecar)',name+' incorrectly enables QA-only sidecar mode')
    if(vars.BACKGROUND_WORKERS_ENABLED!=='false')
      notes.push('WARNING '+name+' currently enables background workers; candidate policy must override before release')
   }
  }catch(e){issues.push('BLOCKED cannot inspect '+name+': '+e.message.split('\n')[0])}
 }
}
if(candidate)for(const [service,image] of Object.entries(candidate)){
 try{
  const result=getDockerJson(['image','inspect',image])[0]
  check(Boolean(result?.Id),'Pulled '+service+' candidate image','Missing '+service+' candidate image')
 }catch{issues.push('BLOCKED candidate image not present for '+service)}
}
const compose=spawnSync('docker',['compose','version'],{encoding:'utf8'})
if(compose.status===0)notes.push('PASS Docker Compose CLI available')
else {
 const standalone=spawnSync('docker-compose',['version'],{encoding:'utf8'})
 if(standalone.status===0)notes.push('PASS docker-compose CLI available')
 else issues.push('BLOCKED no supported Docker Compose command available in this execution environment')
}
console.log([...notes,...issues].join('\n'))
console.log('SUMMARY config='+ (issues.length?'BLOCKED':'READY')+
 ' issues='+issues.length+'; execution authorisation NOT assessed; no changes made')
process.exitCode=issues.length?2:0
