#!/usr/bin/env node
// Explicitly prepares ONLY two empty, internal Docker bridge networks.
// Never launches services, attaches proxies, changes routes/DNS/TLS,
// creates tenants, writes secrets or removes existing resources.
import { execFileSync } from 'node:child_process'
import { assessPilotEdges, creationArgs, dockerNetworkInventory, PILOT_EDGE_DEFINITIONS } from './edge-networks.mjs'

const args=process.argv.slice(2)
const apply=args.length===3 && args[0]==='--apply'
  && args[1]==='--confirm' && args[2]==='PREPARE_EMPTY_PILOT_NETWORKS'
const check=args.length===1 && args[0]==='--check'
if(!check&&!apply){
  console.error('Usage: node prepare-empty-edges.mjs --check | --apply --confirm PREPARE_EMPTY_PILOT_NETWORKS')
  process.exit(2)
}
const docker=argv=>execFileSync('docker',argv,{encoding:'utf8',timeout:12000,maxBuffer:1024*1024})
try{
  const initial=assessPilotEdges(dockerNetworkInventory(docker))
  if(!initial.canCreateMissing) throw new Error('Conflicting pilot network exists; manual review required.')
  if(apply){
    for(const [environment,def] of Object.entries(PILOT_EDGE_DEFINITIONS)){
      if(initial.entries[environment].state==='missing'){
        docker(creationArgs(environment))
      }
    }
  }
  const after=assessPilotEdges(dockerNetworkInventory(docker))
  if(apply&&!after.allPreparedEmpty) throw new Error('Pilot edges were not verified as empty/internal after preparation.')
  console.log(JSON.stringify({
    mode:apply?'prepare-empty-networks':'read-only-check',
    ...after,customerActivation:false,gatewayAttached:false,dnsChanged:false,tlsChanged:false,
    stillRequired:'Independent edge membership approval and validated synthetic runtime before any gateway attachment',
  },null,2))
}catch(error){
  console.error('Pilot edge preparation blocked:',error.message)
  process.exitCode=1
}
