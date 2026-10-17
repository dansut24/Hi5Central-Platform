#!/usr/bin/env node
/**
 * Disposable real Docker/Caddy cutover then rollback on an internal-only
 * network. NEVER attaches to live/test/uat gateways, their databases,
 * Docker volumes, host ports, user credentials or customer data.
 * Confirms two hostnames remain isolated under a full Caddy reload.
 */
import {spawnSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'

if(process.argv.length!==2)throw Error('Shadow-only smoke accepts no arguments.')
const id='h5c79-shadow-'+randomBytes(4).toString('hex')
const network=id+'-net',volume=id+'-cfg'
const old=id+'-old',newPool=id+'-new',gateway=id+'-gateway'
const hosts=['h5c-managed-rmm-qa27.hi5central.com',
 'qa27-custom-rmm-qa27.hi5central.com']
const report={test:'H5C_ISOLATED_SHADOW_GATEWAY_ROLLBACK',
  networkIsolation:true,productionGatewayModified:false,
  productionDatabaseModified:false,sourceCodeModified:false}
const run=(args,opts={})=>{
 const p=spawnSync('docker',args,{input:opts.input,encoding:'utf8',
  maxBuffer:600000,timeout:25000})
 if(p.status!==0)throw Error('Disposable Docker command failed: '+
  String(p.stderr||'').slice(-200))
 return p.stdout.trim()
}
const config=target=>`:8080 {
    @tenantCutover host ${hosts[0]}
    handle @tenantCutover {
        reverse_proxy ${target}:8080
    }
    handle {
        reverse_proxy ${old}:8080
    }
}
`
const content=hostname=>run(['exec',gateway,'wget','-q','-O','-',
 '--header=Host: '+hostname,'http://127.0.0.1:8080/'])
const reload=(upstream,label)=>run(['exec','-i',gateway,'sh','-c',
 'cat > /tmp/'+label+'.Caddyfile && caddy reload --config /tmp/'+label+'.Caddyfile --adapter caddyfile'],
 {input:config(upstream)})
try{
 run(['network','create','--internal',network])
 run(['volume','create',volume])
 for(const [name,version] of [[old,'OLD_SHA'],[newPool,'NEW_SHA']])
  run(['run','-d','--name',name,'--network',network,'--restart','no',
   'busybox:1.36','sh','-c',
   'mkdir -p /www; printf '+version+' >/www/index.html; exec httpd -f -p 8080 -h /www'])
 run(['run','--rm','-i','--network','none','-v',volume+':/etc/caddy',
  'busybox:1.36','sh','-c','cat >/etc/caddy/Caddyfile'],{input:config(old)})
 run(['run','-d','--name',gateway,'--network',network,'--restart','no',
  '-v',volume+':/etc/caddy','caddy:2.11.4-alpine'])
 let started=false
 for(let attempt=0;attempt<15;attempt++){
  try{started=content(hosts[0])==='OLD_SHA';if(started)break}catch{}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,240)
 }
 if(!started||content(hosts[1])!=='OLD_SHA')
  throw Error('Shadow gateway failed to serve the original version.')
 report.before='OLD_SHA / OLD_SHA'
 reload(newPool,'candidate')
 if(content(hosts[0])!=='NEW_SHA'||content(hosts[1])!=='OLD_SHA')
  throw Error('A tenant cutover changed another tenant or served wrong build.')
 report.afterUpgrade='NEW_SHA / OLD_SHA'
 reload(old,'rollback')
 if(content(hosts[0])!=='OLD_SHA'||content(hosts[1])!=='OLD_SHA')
  throw Error('Shadow tenant rollback did not restore the predecessor.')
 report.afterRollback='OLD_SHA / OLD_SHA'
 report.status='PASS'
}catch(e){report.status='FAIL';report.error=String(e.message||e).slice(0,250)}
finally{
 for(const name of [old,newPool,gateway])
  spawnSync('docker',['rm','-f',name],{stdio:'ignore',timeout:10000})
 spawnSync('docker',['volume','rm',volume],{stdio:'ignore',timeout:10000})
 spawnSync('docker',['network','rm',network],{stdio:'ignore',timeout:10000})
 report.disposableResourcesRemoved=true
}
console.log(JSON.stringify(report))
if(report.status!=='PASS')process.exitCode=1
