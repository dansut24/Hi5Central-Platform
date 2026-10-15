// Real, isolated two-gateway QA integration: production-style outer Host
// rewriting, trusted original tenant host, per-tenant version switch + rollback.
// All containers and routes are disposable on the CI runner; no VPS access.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import http from 'node:http'
import {buildTenantRouteCutover} from '../src/tenantRouteCutover.js'
import {renderQaTenantTrustedHostHandles} from '../src/renderQaTenantCaddyRoutes.js'

const seed=process.pid.toString(10)
const net='h5c-route-ci-'+seed, inner='h5c-ci-qa-'+seed, edge='h5c-ci-edge-'+seed
const oldPool='hi5pool-test-ci'+seed+'-old',newPool='hi5pool-test-ci'+seed+'-new'
const containers=[]
const temp=mkdtempSync(join(tmpdir(),'h5c-route-ci-'))
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim()
const SHA_OLD='a'.repeat(40),SHA_NEW='b'.repeat(40)
const now=new Date('2026-10-15T11:30:00Z')
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']
const slugs=['ci-managed-a','ci-custom-a']
const modes=['hi5_managed','admin_controlled']
const poolRow=(tenant,pool,sha)=>({
  tenant_id:ids[tenant],slug:slugs[tenant],
  update_mode:modes[tenant],itsm_entitled:true,environment:'test',
  pool_id:pool,pool_id_verified:pool,build_sha:sha,pool_build_sha:sha,
  pool_state:'verified',api_target:pool+'-api:3001',web_target:pool+'-web:80',
  verified_at:'2026-10-15T11:28:00Z',last_seen_at:'2026-10-15T11:29:00Z',
})
const active=[poolRow(0,oldPool,SHA_OLD),poolRow(1,oldPool,SHA_OLD)]
const job={
  id:'33333333-3333-4333-8333-333333333333',
  tenant_id:ids[0],environment:'test',build_sha:SHA_NEW,status:'running',
  scheduled_at:'2026-10-15T11:00:00Z',
  lease_token:'44444444-4444-4444-8444-444444444444',
  lease_fence:1,lease_expires_at:'2026-10-15T11:35:00Z',
}
const plan=buildTenantRouteCutover({
  environment:'test',tenantId:ids[0],slug:slugs[0],
  mode:modes[0],itsmEntitled:true,job,
  candidate:poolRow(0,newPool,SHA_NEW),activeRows:active,now,
})
const renderInner=manifest=>[
  'http://test.hi5central.com {',
  renderQaTenantTrustedHostHandles(manifest),
  '    @fallbackApi path /api/*',
  '    handle @fallbackApi {',
  '        reverse_proxy '+oldPool+'-api:3001',
  '    }',
  '    handle {',
  '        reverse_proxy '+oldPool+'-web:80',
  '    }',
  '}','',
].join('\n')
writeFileSync(join(temp,'Caddyfile'),renderInner(plan.rollback))
writeFileSync(join(temp,'new.Caddyfile'),renderInner(plan.stage))
writeFileSync(join(temp,'edge.Caddyfile'),[
  ':80 {',
  '    reverse_proxy '+inner+':80 {',
  '        header_up Host test.hi5central.com',
  '        header_up X-Hi5-Tenant-Host {http.request.host}',
  '    }',
  '}','',
].join('\n'))

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function get(port,host,path,extra={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method:'GET',
      headers:{Host:host,...extra},timeout:3000},response=>{
      let body=''
      response.on('data',chunk=>{body+=chunk.toString()})
      response.on('end',()=>resolve({status:response.statusCode,body:body.trim()}))
    })
    req.on('error',reject)
    req.on('timeout',()=>req.destroy(Error('QA Caddy response timeout.')))
    req.end()
  })
}
async function assertRoute(port,slug,api,web){
  const host=slug+'-test.hi5central.com'
  const a=await get(port,host,'/api/')
  const w=await get(port,host,'/')
  assert.deepEqual(a,{status:200,body:api},host+' API exact-version assertion')
  assert.deepEqual(w,{status:200,body:web},host+' frontend exact-version assertion')
}
async function waitForRoute(port,slug,api,web){
  let last
  for(let attempt=0;attempt<30;attempt++){
    try{return await assertRoute(port,slug,api,web)}
    catch(error){last=error;await sleep(150)}
  }
  throw last
}
try{
  docker('network','create',net)
  for(const [pool,version] of [[oldPool,'old'],[newPool,'new']]){
    for(const [role,port] of [['api',3001],['web',80]]){
      const name=pool+'-'+role,body=version+'-'+role
      const command='mkdir -p /www/api; printf '+body+' > /www/index.html; printf '+
        body+' > /www/api/index.html; httpd -f -p '+port+' -h /www'
      docker('run','-d','--rm','--network',net,'--name',name,
        'busybox:1.36','sh','-c',command)
      containers.push(name)
    }
  }
  docker('run','-d','--rm','--network',net,'--name',inner,
    '-v',temp+':/etc/caddy:ro',
    'caddy:2.11.4-alpine','caddy','run','--config','/etc/caddy/Caddyfile')
  containers.push(inner)
  docker('run','-d','--rm','--network',net,'--name',edge,
    '-p','127.0.0.1::80','-v',temp+':/etc/caddy:ro',
    'caddy:2.11.4-alpine','caddy','run','--config','/etc/caddy/edge.Caddyfile')
  containers.push(edge)
  const port=Number(docker('port',edge,'80/tcp').split(':').at(-1))
  assert(Number.isInteger(port)&&port>1024)
  await waitForRoute(port,slugs[0],'old-api','old-web')
  await waitForRoute(port,slugs[1],'old-api','old-web')

  // The outer gateway MUST overwrite a caller-supplied spoofed identity
  // header. Only the real Host: custom tenant may select its route.
  let spoofed=await get(port,slugs[1]+'-test.hi5central.com','/api/',{
    'X-Hi5-Tenant-Host':slugs[0]+'-test.hi5central.com'})
  assert.deepEqual(spoofed,{status:200,body:'old-api'})
  docker('exec',inner,'caddy','reload','--config','/etc/caddy/new.Caddyfile')
  await waitForRoute(port,slugs[0],'new-api','new-web')
  await waitForRoute(port,slugs[1],'old-api','old-web')
  spoofed=await get(port,slugs[1]+'-test.hi5central.com','/api/',{
    'X-Hi5-Tenant-Host':slugs[0]+'-test.hi5central.com'})
  assert.deepEqual(spoofed,{status:200,body:'old-api'},
    'Spoofed routing header must not reveal the upgraded tenant release')

  docker('exec',inner,'caddy','reload','--config','/etc/caddy/Caddyfile')
  await waitForRoute(port,slugs[0],'old-api','old-web')
  await waitForRoute(port,slugs[1],'old-api','old-web')
  console.log('PASS two-hop Caddy HTTP: original Host safely preserved through rewrite, isolated tenant upgrade, peer unchanged, spoof denied, rollback.')
}finally{
  for(const c of containers.reverse()){
    try{docker('rm','-f',c)}catch{}
  }
  try{docker('network','rm',net)}catch{}
  rmSync(temp,{recursive:true,force:true})
}
