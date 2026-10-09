#!/usr/bin/env node
// Phase 11: Docker inventory WITHOUT mutation. Never prints environment
// values, passwords, private keys, labels containing auth data or raw config.
import { execFileSync } from 'node:child_process'
import { reconcileLegacy } from './reconcile-legacy.mjs'

const requiredFlag=process.argv.slice(2)
if(requiredFlag.length!==1 || requiredFlag[0]!=='--read-only'){
  console.error('Usage: node inventory-legacy.mjs --read-only')
  process.exit(2)
}
function docker(args, timeout=15000){
  return execFileSync('docker',args,{encoding:'utf8',timeout,maxBuffer:4*1024*1024})
}
function json(args){return JSON.parse(docker(args))}
const allowedProjects=['hi5central-uat','hi5central-test']
const projects=[]
let gatewayEvidenceComplete=true

for(const name of allowedProjects){
  const ids=docker(['ps','--all','--filter',`label=com.docker.compose.project=${name}`,'--format','{{.ID}}'])
    .trim().split('\n').filter(Boolean)
  if(!ids.length){
    projects.push({name,containers:[],routes:[],volumes:[]})
    gatewayEvidenceComplete=false
    continue
  }
  const raw=json(['inspect',...ids])
  const containers=raw.map(item=>{
    const env=Object.fromEntries((item.Config?.Env||[])
      .filter(x=>/^(TENANCY_MODE|RUNTIME_ENVIRONMENT)=/.test(x))
      .map(x=>x.split('=',2)))
    return {
      name:item.Name.replace(/^\//,''),
      service:item.Config?.Labels?.['com.docker.compose.service'] || 'unclassified',
      image:item.Config?.Image || 'unknown',
      state:item.State?.Status || 'unknown',
      health:item.State?.Health?.Status || 'unavailable',
      tenancyMode:env.TENANCY_MODE || 'unverified',
      runtimeEnvironment:env.RUNTIME_ENVIRONMENT || 'unverified',
      networks:Object.keys(item.NetworkSettings?.Networks || {}).sort(),
      publishedPorts:Object.entries(item.NetworkSettings?.Ports || {})
        .filter(([,m])=>Array.isArray(m)&&m.length)
        .flatMap(([containerPort,m])=>m.map(x=>({
          containerPort,hostIp:x.HostIp,hostPort:x.HostPort,
        }))),
    }
  })
  const volumes=docker(['volume','ls','--format','{{.Name}}'])
    .trim().split('\n').filter(x=>x.startsWith(name+'_')).sort()
  const gateway=containers.find(x=>x.service==='gateway')
  const routes=[]
  if(gateway){
    try{
      const caddy=docker(['exec',gateway.name,'cat','/etc/caddy/Caddyfile'])
      let latestHost=''
      for(const line of caddy.split(/\r?\n/)){
        const candidate=/^\s*(?:https?:\/\/)?([a-zA-Z0-9.-]+(?:,\s*(?:https?:\/\/)?[a-zA-Z0-9.-]+)*)\s*\{/.exec(line)
        if(candidate){
          const hosts=candidate[1].split(',').map(x=>x.trim().replace(/^https?:\/\//,'').toLowerCase())
          latestHost=hosts.filter(h=>/^[a-z0-9.-]+$/.test(h))
        }
        const target=/^\s*reverse_proxy\s+([a-zA-Z0-9_.:-]+)\s*$/.exec(line)
        if(target && Array.isArray(latestHost)){
          for(const hostname of latestHost) routes.push({hostname,target:target[1]})
        }
      }
      if(!routes.length) gatewayEvidenceComplete=false
    }catch{
      gatewayEvidenceComplete=false
    }
  }else gatewayEvidenceComplete=false
  projects.push({name,containers,routes,volumes})
}
let sharedEdgeMembers=[]
try{
  const edge=json(['network','inspect','hi5central'])[0]
  sharedEdgeMembers=Object.values(edge?.Containers || {}).map(v=>v.Name).filter(Boolean).sort()
}catch{gatewayEvidenceComplete=false}
const snapshot={
  projects,sharedEdgeMembers,
  gatewayEvidenceComplete,
  // This tool never performs DNS, TLS, route activation or approvals.
  dnsTlsIndependentlyVerified:false,
}
const report=reconcileLegacy(snapshot)
console.log(JSON.stringify({
  inventory:snapshot,
  reconciliation:report,
  collectedUsing:'docker read-only inspect/ps/volume/network and gateway configuration read',
  secretsExposed:false,
  noChangesMade:true,
},null,2))
