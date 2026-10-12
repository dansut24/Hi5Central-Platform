#!/usr/bin/env node
// Host-only QA release adapter. It cannot create wildcard routes, mint
// signatures, attach networks, start containers or touch Production gateways.
// Dry-run is default; --apply ALSO requires a protected environment approval,
// explicit operator enablement and a fresh Ed25519 release-authority signature.
import {execFileSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,appendFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {runQaSandboxHostTransaction,validateQaSandboxHostIntent} from '../../src/qaSandboxHostRelease.js'

const argv=process.argv.slice(2)
const value=k=>{const n=argv.indexOf(k);return n<0?null:argv[n+1]}
const apply=argv.includes('--apply')
const paths=['--intent','--signature','--public-key']
if(paths.some(k=>!value(k)))throw Error('Provide --intent, --signature and --public-key files.')
const intent=JSON.parse(readFileSync(resolve(value('--intent')),'utf8'))
const signature=readFileSync(resolve(value('--signature')),'utf8').trim()
const publicKeyPem=readFileSync(resolve(value('--public-key')),'utf8')
const approved=process.env.HI5_QA_SANDBOX_ROUTE_APPLY_ENABLED==='true'
if(apply&&!approved)throw Error('QA route activation requires an approved host enablement flag.')
const scope=validateQaSandboxHostIntent({intent,signature,publicKeyPem})
const gateway=scope.gateway
const volume='hi5central-'+scope.environment+'_gateway_runtime_config'
const auditDir='/opt/hi5central/deployment/qa-route-audit'
const sha=v=>createHash('sha256').update(v).digest('hex')
const temp=mkdtempSync(join(tmpdir(),'hi5-qa-route-'))
const prefix=scope.tenantSlug+'-'+scope.environment+'-'+intent.routeGeneration
const targetConfig='/config/qa-release-'+prefix+'.caddy'
const previousConfig='/config/qa-release-'+prefix+'.previous.caddy'
const docker=(args,options={})=>execFileSync('docker',args,{
  encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,...options,
})
const volumeText=()=>docker(['run','--rm','-v',volume+':/config:ro',
  '--entrypoint','sh','caddy:2-alpine','-c','cat /config/Caddyfile'])
const saveVolume=contents=>docker(['run','--rm','-i','-v',volume+':/config:rw',
  '--entrypoint','sh','caddy:2-alpine','-c','cat > /config/Caddyfile; sync'],
  {input:contents,timeout:45000})
const pushConfig=(contents,to)=>{
  const local=join(temp,'Caddyfile')
  writeFileSync(local,contents,{mode:0o600})
  docker(['cp',local,gateway+':'+to])
}
const findContainer=upstream=>{
  const name=upstream.split(':')[0]
  const row=JSON.parse(docker(['inspect',name]))[0]
  const digest=name===intent.nextApiTarget.split(':')[0]?intent.apiImageDigest:intent.webImageDigest
  if(!row||row.State.Status!=='running'||row.State.Health?.Status!=='healthy'
    ||row.Image!=='sha256:'+digest
    ||row.Config.Labels?.['org.opencontainers.image.revision']!==intent.buildSha)
    throw Error('Unhealthy, wrong revision or wrong signed local image ID: '+name)
  const env=Object.fromEntries((row.Config.Env||[]).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}))
  if(env.RUNTIME_ENVIRONMENT!==scope.environment||env.VERSIONED_POOL_TENANT_SLUG!==scope.tenantSlug)
    throw Error('Candidate pool lacks tenant and environment isolation: '+name)
  const gw=JSON.parse(docker(['inspect',gateway]))[0]
  if(!Object.keys(row.NetworkSettings.Networks||{}).some(x=>Object.hasOwn(gw.NetworkSettings.Networks||{},x)))
    throw Error('Candidate is not reachable by its authorised sandbox gateway.')
}
const publicSha=async path=>{
  const r=await fetch('https://'+scope.host+path,{
    cache:'no-store',redirect:'error',
    headers:{Origin:'https://'+scope.host,'Cache-Control':'no-store'},
    signal:AbortSignal.timeout(12000),
  })
  if(r.status!==200||!String(r.headers.get('content-type')||'').includes('application/json'))
    throw Error('Expected JSON build metadata from '+path+'; received HTTP '+r.status)
  const j=await r.json()
  if(!/^[a-f0-9]{40}$/.test(String(j.sha||'')))
    throw Error('The public build metadata has no immutable SHA: '+path)
  return j.sha
}
let savedBefore=null
const adapter={
  gateway,
  async readActiveConfig(){
    const active=docker(['exec',gateway,'cat','/etc/caddy/Caddyfile'])
    const persisted=volumeText()
    if(active!==persisted)throw Error('Sandbox gateway Caddy startup mount differs from active config.')
    return active
  },
  async validateCandidate(candidate){
    pushConfig(candidate,targetConfig)
    docker(['exec',gateway,'caddy','validate','--config',targetConfig,'--adapter','caddyfile'])
  },
  async verifyTargetBuild(){
    findContainer(intent.nextApiTarget)
    findContainer(intent.nextUpstream)
    // Fail closed unless the public previous build has a verifiable API+web
    // baseline for automatic rollback.
    for(const path of ['/release-manifest.json','/api/v1/updates/version']){
      if(await publicSha(path)!==intent.previousBuildSha)
        throw Error('Signed previous public SHA does not match '+path)
    }
  },
  async preserveRollback(previous){
    mkdirSync(auditDir,{recursive:true,mode:0o700})
    const filename=join(auditDir,'before-'+prefix+'.caddy')
    writeFileSync(filename,previous,{flag:'wx',mode:0o600})
    savedBefore=filename
    pushConfig(previous,previousConfig)
  },
  async activateCandidate(candidate){
    saveVolume(candidate)
    if(volumeText()!==candidate)throw Error('Candidate did not persist into the gateway volume.')
    docker(['exec',gateway,'caddy','reload','--config',targetConfig,'--adapter','caddyfile'])
  },
  async verifyPublicRoute(){
    for(const path of ['/release-manifest.json','/api/v1/updates/version']){
      if(await publicSha(path)!==intent.buildSha)
        throw Error('Public frontend/API SHA mismatch: '+path)
    }
    const login=await fetch('https://'+scope.host+'/login',{
      redirect:'error',signal:AbortSignal.timeout(12000)})
    if(login.status!==200)throw Error('Login screen is unavailable after the QA cutover.')
  },
  async recordActivation(_,preview){
    appendFileSync(join(auditDir,'qa-host-releases.jsonl'),
      JSON.stringify({timestamp:new Date().toISOString(),...preview,
        signedApprovalRunId:intent.approvedRunId,scope:'qa_sandbox_only',
        state:'host_verified_control_plane_attestation_pending'})+'\n',{mode:0o600})
  },
  async restoreRollback(previous){
    if(!savedBefore)throw Error('A durable before-image was not recorded.')
    saveVolume(previous)
    docker(['exec',gateway,'caddy','reload','--config',previousConfig,'--adapter','caddyfile'])
  },
  async verifyRestoredRoute(){
    if(volumeText()!==readFileSync(savedBefore,'utf8'))
      throw Error('The gateway startup volume did not restore its before-image.')
    for(const path of ['/release-manifest.json','/api/v1/updates/version']){
      if(await publicSha(path)!==intent.previousBuildSha)
        throw Error('Previous public build was not restored: '+path)
    }
  },
}
try{
  const result=await runQaSandboxHostTransaction({
    intent,signature,publicKeyPem,adapter,applyEnabled:apply&&approved,
  })
  // The host receipt is not yet a database-controlled release assignment.
  console.log(JSON.stringify({...result,gateway,host:scope.host,
    controlPlaneAttested:false}))
}finally{
  rmSync(temp,{recursive:true,force:true})
}
