#!/usr/bin/env node
// Deliberate short-lived diagnostic: runs two unprivileged Node probes on the
// approved, EMPTY pilot edges and removes them. No gateway, volumes, secrets,
// host ports, or API listeners are used. It never activates a tenant.
import { execFileSync } from 'node:child_process'
import { assessPilotEdges, dockerNetworkInventory, PILOT_EDGE_DEFINITIONS } from './edge-networks.mjs'

if (process.argv.length!==5 || process.argv[2]!=='--probe'
    || process.argv[3]!=='--confirm'
    || process.argv[4]!=='EPHEMERAL_CONTAINERS_ONLY') {
  console.error('Usage: node probe-edge-isolation.mjs --probe --confirm EPHEMERAL_CONTAINERS_ONLY')
  process.exit(2)
}
const image='ghcr.io/dansut24/hi5central-platform-api:dev'
const run=(args,timeout=20000)=>execFileSync('docker',args,{encoding:'utf8',timeout,maxBuffer:1024*1024})
const id=Math.random().toString(16).slice(2,10)
const names={uat:'hi5-phase12-net-uat-'+id,test:'hi5-phase12-net-test-'+id}
const started=[]
const serverScript=`require('net').createServer(c=>c.end('phase12')).listen(18080,'0.0.0.0');setInterval(()=>{},30000)`
const clientScript=`const net=require('net');let done=false;
const socket=net.connect({host:process.argv[1],port:18080,timeout:1600});
function finish(v){if(!done){done=true;socket.destroy();process.exit(v)}}
socket.once('connect',()=>finish(process.argv[2]==='allow'?0:7));
socket.once('timeout',()=>finish(process.argv[2]==='deny'?0:8));
socket.once('error',()=>finish(process.argv[2]==='deny'?0:9));
setTimeout(()=>finish(process.argv[2]==='deny'?0:10),2300)`
try {
  const first=assessPilotEdges(dockerNetworkInventory(run))
  if(!first.allPreparedEmpty) throw new Error('Both labelled pilot edge bridges must start empty.')
  for(const env of ['uat','test']){
    const def=PILOT_EDGE_DEFINITIONS[env]
    run(['run','--rm','--detach','--pull','never','--network',def.name,
      '--name',names[env],'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--entrypoint','node',image,'-e',serverScript])
    started.push(names[env])
  }
  const info=JSON.parse(run(['inspect',...started]))
  const ip=Object.fromEntries(info.map(item=>{
    const env=item.Name.includes('net-uat-')?'uat':'test'
    return [env,item.NetworkSettings.Networks[PILOT_EDGE_DEFINITIONS[env].name]?.IPAddress]
  }))
  if(!ip.uat || !ip.test) throw new Error('Could not inspect probe-only private container addresses.')
  const assertConnection=(source,target,expectation)=>{
    run(['exec',names[source],'node','-e',clientScript,target,expectation],10000)
  }
  // Own-container TCP works. Cross-environment TCP must NOT work.
  assertConnection('uat','127.0.0.1','allow')
  assertConnection('test','127.0.0.1','allow')
  assertConnection('uat',ip.test,'deny')
  assertConnection('test',ip.uat,'deny')
  console.log(JSON.stringify({
    result:'isolated-network-probes-passed',
    ownNetworkTcp:true,crossEnvironmentTcp:false,
    noPublishedPorts:true,noSecretsUsed:true,noCustomerActivation:true,
    testContainersWillBeRemoved:true,
  },null,2))
} catch(error) {
  console.error('Pilot edge isolation probe FAILED:',error.message.slice(0,240))
  process.exitCode=1
} finally {
  for(const name of started){
    try{run(['rm','--force',name],10000)}catch{}
  }
  // Verify both networks are still empty. Never print raw network objects.
  try{
    const after=assessPilotEdges(dockerNetworkInventory(run))
    if(!after.allPreparedEmpty){
      console.error('Pilot edge cleanup requires operator attention: network has unexpected attachments.')
      process.exitCode=1
    } else console.log('Both pilot edge networks empty following probe.')
  }catch{
    console.error('Could not verify network cleanup.')
    process.exitCode=1
  }
}
