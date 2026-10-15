// End-to-end outer Caddy -> inner QA Caddy host identity validation.
//
// Models the REAL VPS architecture: outer HTTPS edge rewrites Host to
// test.hi5central.com and overwrites X-Hi5-Tenant-Host with original host.
// A forged client header must never grant routing to another tenant's pool.
// Runs only on a disposable GitHub Actions Docker bridge with synthetic hosts.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import http from 'node:http'
import {buildHostRoutingManifest} from '../src/runtimePoolControl.js'
import {renderQaTenantTrustedHostHandles} from '../src/renderQaTenantCaddyRoutes.js'
import {renderQaOuterHandoff,validateQaHandoffCoverage} from '../src/qaGatewayHostHandoff.js'

const stamp=process.pid.toString(),network='h5c-handoff-ci-'+stamp
const edge='h5c-ci-edge-'+stamp,inner='h5c-ci-qa-'+stamp
const poolOld='hi5pool-test-ci-'+stamp+'-old'
const poolNew='hi5pool-test-ci-'+stamp+'-new'
const containers=[],dir=mkdtempSync(join(tmpdir(),'h5c-handoff-'))
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim()
const now=new Date('2026-10-15T11:30:00Z')
const versionOld='a'.repeat(40),versionNew='b'.repeat(40)
const slugs=['ci-managed-a','ci-custom-a','ci-managed-b','ci-custom-b']
const ids=['11111111-1111-4111-8111-111111111111',
'22222222-2222-4222-8222-222222222222',
'33333333-3333-4333-8333-333333333333',
'44444444-4444-4444-8444-444444444444']
const row=(i,isNew=false)=>{
  const name=isNew?poolNew:poolOld
  const sha=isNew?versionNew:versionOld
  return {tenant_id:ids[i],slug:slugs[i],environment:'test',
    itsm_entitled:true,update_mode:i%2?'admin_controlled':'hi5_managed',
    pool_id:name,build_sha:sha,pool_build_sha:sha,pool_state:'verified',
    api_target:name+'-api:3001',web_target:name+'-web:80',
    verified_at:'2026-10-15T11:28:00Z',last_seen_at:'2026-10-15T11:29:00Z'}
}
const initial=slugs.map((_,i)=>row(i))
const advanced=slugs.map((_,i)=>row(i,i===0))
const innerConfig=rows=>{
  const manifest=buildHostRoutingManifest({environment:'test',rows,now})
  return [
    'http://test.hi5central.com {',
    renderQaTenantTrustedHostHandles(manifest),
    '    @fallbackApi path /api/*',
    '    handle @fallbackApi { reverse_proxy '+poolOld+'-api:3001 }',
    '    handle { reverse_proxy '+poolOld+'-web:80 }',
    '}','',
  ].join('\n')
}
const edgeFragment=renderQaOuterHandoff('test',{upstream:inner+':80'})
const edgeConfig=[
  ':80 {',
  edgeFragment,
  '    handle { respond "blocked" 404 }',
  '}','',
].join('\n')
writeFileSync(join(dir,'edge.Caddyfile'),edgeConfig)
writeFileSync(join(dir,'inner.Caddyfile'),innerConfig(initial))
writeFileSync(join(dir,'inner-next.Caddyfile'),innerConfig(advanced))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const get=(port,host,path='/',spoof='')=>new Promise((resolve,reject)=>{
  const headers={Host:host}
  if(spoof)headers['X-Hi5-Tenant-Host']=spoof
  const req=http.request({hostname:'127.0.0.1',port,path,headers,timeout:3500},res=>{
    let body='';res.on('data',data=>{body+=data.toString()})
    res.on('end',()=>resolve({status:res.statusCode,body:body.trim()}))
  })
  req.on('error',reject)
  req.on('timeout',()=>req.destroy(Error('QA proxy timeout.')))
  req.end()
})
async function expect(port,host,expected,spoof=''){
  let last
  for(let i=0;i<30;i++){
    try{
      const result=await get(port,host,'/api/',spoof)
      const page=await get(port,host,'/',spoof)
      assert.deepEqual(result,{status:expected==='blocked'?404:200,body:expected==='blocked'?'blocked':expected+'-api'})
      assert.deepEqual(page,{status:expected==='blocked'?404:200,body:expected==='blocked'?'blocked':expected+'-web'})
      return
    }catch(err){last=err;await sleep(130)}
  }
  throw last
}
try{
  const coverage=validateQaHandoffCoverage(edgeFragment,'test')
  assert.equal(coverage.checkedQaProxies,2)
  assert.throws(()=>validateQaHandoffCoverage(edgeFragment.replace(
    'header_up X-Hi5-Tenant-Host test.hi5central.com','header_down X-Hi5-Tenant-Host test.hi5central.com'
  ),'test'),/untrusted/)
  docker('network','create',network)
  for(const [pool,version] of [[poolOld,'old'],[poolNew,'new']]){
    for(const [role,port] of [['api',3001],['web',80]]){
      const name=pool+'-'+role,body=version+'-'+role
      const command='mkdir -p /www/api; printf '+body+' > /www/index.html; printf '+
        body+' > /www/api/index.html; httpd -f -p '+port+' -h /www'
      docker('run','-d','--rm','--network',network,'--name',name,
        'busybox:1.36','sh','-c',command)
      containers.push(name)
    }
  }
  docker('run','-d','--rm','--network',network,'--name',inner,
    '-v',dir+':/etc/caddy:ro',
    'caddy:2.11.4-alpine','caddy','run','--config','/etc/caddy/inner.Caddyfile')
  containers.push(inner)
  docker('run','-d','--rm','--network',network,'--name',edge,
    '-p','127.0.0.1::80','-v',dir+':/etc/caddy:ro',
    'caddy:2.11.4-alpine','caddy','run','--config','/etc/caddy/edge.Caddyfile')
  containers.push(edge)
  const port=Number(docker('port',edge,'80/tcp').split(':').at(-1))
  assert(Number.isInteger(port)&&port>1024)
  for(const slug of slugs)await expect(port,slug+'-test.hi5central.com','old')

  // Client-supplied tenant header MUST NOT override the original request host.
  const spoof=slugs[0]+'-test.hi5central.com'
  await expect(port,'unregistered-test.hi5central.com','old',spoof)
  await expect(port,'test.hi5central.com','old',spoof)
  await expect(port,'ci-managed-a-uat.hi5central.com','blocked',spoof)

  docker('exec',inner,'caddy','reload','--config','/etc/caddy/inner-next.Caddyfile')
  await expect(port,slugs[0]+'-test.hi5central.com','new')
  for(const slug of slugs.slice(1))await expect(port,slug+'-test.hi5central.com','old')
  // Spoofing after a release also cannot access the newly deployed tenant.
  await expect(port,'unregistered-test.hi5central.com','old',spoof)
  await expect(port,'test.hi5central.com','old',spoof)

  docker('exec',inner,'caddy','reload','--config','/etc/caddy/inner.Caddyfile')
  for(const slug of slugs)await expect(port,slug+'-test.hi5central.com','old')
  console.log('PASS: outer+inner Caddy HTTP, 4 tenant hosts, 1 upgraded, 3 unchanged, forged headers blocked, rollback restored.')
}finally{
  for(const name of containers.reverse())try{docker('rm','-f',name)}catch{}
  try{docker('network','rm',network)}catch{}
  rmSync(dir,{recursive:true,force:true})
}
