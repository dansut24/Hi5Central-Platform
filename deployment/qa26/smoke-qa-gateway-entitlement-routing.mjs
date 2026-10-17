#!/usr/bin/env node
/**
 * Real disposable Caddy HTTP behaviour test of the exact QA deny clauses
 * in the previously archived private gateway reconciliation candidate.
 * No host ports, customer gateway, database write, or customer data.
 */
import {spawnSync} from 'node:child_process'
import {randomBytes,createHash} from 'node:crypto'
if(process.argv.length!==2)throw Error('No production/deployment parameters accepted.')
const run=(args,opts={})=>{
 const p=spawnSync('docker',args,{
  encoding:'utf8',input:opts.input,timeout:opts.timeout||30000,
  maxBuffer:300000,
 })
 if(p.status!==0)
  throw Error('Isolated Docker smoke command failed: '+String(p.stderr).slice(-140))
 return p.stdout
}
const source=run(['run','--rm','--network','none','--mount',
 'type=volume,source=h5c_release79_live_caddy_20261017,target=/backup,readonly',
 'busybox:1.36','cat','/backup/qa-entitlement-candidate.Caddyfile'])
const sha=createHash('sha256').update(source).digest('hex')
if(sha!=='b8b408916f6c3f9d9cddcb8558baf915433e5edd20fd4d2dfd0045affba94e4e')
 throw Error('QA review candidate SHA changed since security review.')
const extract=(type)=>{
 const start='# QA_ENTITLEMENT_GUARD_'+type+'_BEGIN'
 const end='# QA_ENTITLEMENT_GUARD_'+type+'_END'
 const pieces=source.split(start)
 if(pieces.length!==2||pieces[1].split(end).length!==2)
  throw Error('Missing or ambiguous reviewed QA '+type+' deny clause.')
 return pieces[1].split(end)[0]
}
const config=`:8080 {
${extract('UAT')}
${extract('RMM')}
    @tenantUatWorkspace expression {http.request.host}.matches('(?i)^[a-z0-9-]+-uat[.]hi5central[.]com$')
    handle @tenantUatWorkspace {
        respond "UAT_ALLOWED" 200
    }
    @tenantRmm expression {http.request.host}.endsWith('-rmm.hi5central.com')
    handle @tenantRmm {
        respond "RMM_ALLOWED" 200
    }
    handle {
        respond "FALLBACK_OK" 200
    }
}
`
const id='h5c79qa-ent-'+randomBytes(4).toString('hex')
const volume=id+'-cfg',gateway=id+'-caddy'
const managed=['h5c-managed-qa26','managed1','managed2',
 'h5c-managed-rmm-qa27','qa27-managed-itsm-qa27']
const custom=['h5c-custom-qa26','custom1','custom2',
 'qa27-custom-rmm-qa27','qa27-custom-itsm-qa27']
const nonRmm=[...managed,...custom].filter(s=>![
 'h5c-managed-rmm-qa27','qa27-custom-rmm-qa27'].includes(s))
const counts={managedUatDenied:0,nonRmmDenied:0,sandboxRmmDenied:0,
 entitledRmmAllowed:0,customUatAllowed:0}
let passed=false
try{
 run(['volume','create',volume])
 run(['run','--rm','-i','--network','none','--mount',
  'type=volume,source='+volume+',target=/etc/caddy','busybox:1.36',
  'sh','-c','cat >/etc/caddy/Caddyfile'],{input:config})
 run(['run','-d','--name',gateway,'--network','none',
  '--restart','no','--read-only','--tmpfs','/tmp:rw,size=10m',
  '--mount','type=volume,source='+volume+',target=/etc/caddy,readonly',
  'caddy:2.11.4-alpine'])
 const check=(host,expected)=>{
  let output=''
  for(let i=0;i<12;i++){
   const p=spawnSync('docker',['exec',gateway,'wget','-S',
    '-O','-','--header=Host: '+host,'http://127.0.0.1:8080/'],{
    encoding:'utf8',timeout:8000,maxBuffer:25000})
   output=String(p.stderr||'')+'\n'+String(p.stdout||'')
   const status=/HTTP\/1[.]1\s+(\d{3})/.exec(output)?.[1]
   if(status){
    if(Number(status)!==expected)throw Error(host+' expected '+expected+' got '+status)
    return
   }
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)
  }
  throw Error('No HTTP response from isolated Caddy for '+host)
 }
 for(const slug of managed){
  for(const host of [slug+'-uat.hi5central.com',
    slug+'-uat-portal.hi5central.com']){
   check(host,404);counts.managedUatDenied++
  }
 }
 for(const slug of nonRmm){
  check(slug+'-rmm.hi5central.com',404);counts.nonRmmDenied++
 }
 for(const slug of [...managed,...custom]){
  for(const sandbox of ['test','uat']){
   check(slug+'-'+sandbox+'-rmm.hi5central.com',404)
   counts.sandboxRmmDenied++
  }
 }
 for(const slug of ['h5c-managed-rmm-qa27','qa27-custom-rmm-qa27']){
  check(slug+'-rmm.hi5central.com',200);counts.entitledRmmAllowed++
 }
 for(const slug of custom){
  check(slug+'-uat.hi5central.com',200);counts.customUatAllowed++
 }
 check('qa-safe-unrelated.hi5central.com',200)
 passed=true
}finally{
 spawnSync('docker',['rm','-f',gateway],{stdio:'ignore',timeout:12000})
 spawnSync('docker',['volume','rm',volume],{stdio:'ignore',timeout:12000})
}
console.log(JSON.stringify({status:passed?'PASS':'FAIL',candidateSha256:sha,
 ...counts,unrelatedHostUntouched:passed,productionGatewayChanged:false,
 publishedReleaseChanged:false,disposableResourcesRemoved:true}))
if(!passed)process.exitCode=2
