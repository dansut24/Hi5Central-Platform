// Isolated, disposable live-HTTP QA for two tenants on one Caddy gateway.
// Uses real Caddy 2.11.4 and BusyBox backends on a private CI Docker network.
// NO contact with the Hi5Central VPS, production DNS, customers or databases.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import http from 'node:http'
import {buildTenantRouteCutover} from '../src/tenantRouteCutover.js'
import {renderQaTenantCaddyRoutes} from '../src/renderQaTenantCaddyRoutes.js'

const seed=process.pid.toString(10)
const net='h5c-route-ci-'+seed, gateway='h5c-ci-caddy-'+seed
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
const existing=[poolRow(0,oldPool,SHA_OLD),poolRow(1,oldPool,SHA_OLD)]
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
  candidate:poolRow(0,newPool,SHA_NEW),activeRows:existing,now,
})
writeFileSync(join(temp,'Caddyfile'),renderQaTenantCaddyRoutes(plan.rollback))
writeFileSync(join(temp,'new.Caddyfile'),renderQaTenantCaddyRoutes(plan.stage))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function get(port,host,path){
  return new Promise((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port,path,
      method:'GET',headers:{Host:host},timeout:3000},response=>{
      let body=''
      response.on('data',chunk=>{body+=chunk.toString()})
      response.on('end',()=>resolve({status:response.statusCode,body:body.trim()}))
    })
    request.on('error',reject)
    request.on('timeout',()=>request.destroy(Error('Caddy request timed out.')))
    request.end()
  })
}
async function assertRoute(port,slug,api,web){
  const host=slug+'-test.hi5central.com'
  const a=await get(port,host,'/api/')
  const w=await get(port,host,'/')
  assert.deepEqual(a,{status:200,body:api},host+' API must resolve correct immutable pool')
  assert.deepEqual(w,{status:200,body:web},host+' frontend must resolve correct immutable pool')
}
try{
  // Disposable CI-only bridge allows localhost port publishing for HTTP proof.
  docker('network','create',net)
  for(const [pool,version] of [[oldPool,'old'],[newPool,'new']]){
    for(const [role,port] of [['api',3001],['web',80]]){
      const name=pool+'-'+role
      const content=version+'-'+role
      const command='mkdir -p /www/api; printf '+content+' > /www/index.html; printf '+
        content+' > /www/api/index.html; httpd -f -p '+port+' -h /www'
      docker('run','-d','--rm','--network',net,'--name',name,
        'busybox:1.36','sh','-c',command)
      containers.push(name)
    }
  }
  docker('run','-d','--rm','--network',net,'--name',gateway,
    '-p','127.0.0.1::80','-v',temp+':/etc/caddy:ro',
    'caddy:2.11.4-alpine','caddy','run','--config','/etc/caddy/Caddyfile')
  containers.push(gateway)
  const port=Number(docker('port',gateway,'80/tcp').split(':').at(-1))
  assert(Number.isInteger(port)&&port>1024)
  let ready=false
  for(let attempt=0;attempt<25;attempt++){
    try{await assertRoute(port,slugs[0],'old-api','old-web');ready=true;break}
    catch{await sleep(200)}
  }
  assert.equal(ready,true,'Initial Caddy routes never became healthy')
  await assertRoute(port,slugs[1],'old-api','old-web')

  // A real, atomic Caddy config reload changes one host's version only.
  docker('exec',gateway,'caddy','reload','--config','/etc/caddy/new.Caddyfile')
  await assertRoute(port,slugs[0],'new-api','new-web')
  await assertRoute(port,slugs[1],'old-api','old-web')

  // Failback is the exact previously verified generation, not a heuristic.
  docker('exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile')
  await assertRoute(port,slugs[0],'old-api','old-web')
  await assertRoute(port,slugs[1],'old-api','old-web')
  console.log('PASS real Caddy HTTP: two isolated tenants, one changed, untouched peer, old→new→rollback.')
}finally{
  for(const c of containers.reverse()){
    try{docker('rm','-f',c)}catch{}
  }
  try{docker('network','rm',net)}catch{}
  rmSync(temp,{recursive:true,force:true})
}
