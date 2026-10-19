import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {withGatewayLock} from '../src/releaseGatewayCoordinator.js'

const options=stage=>({gateway:stage,workerId:'test-worker-'+stage})
function fakePool(){
 const held=new Set()
 const attempted=[]
 return {
  attempted,
  async connect(){
   return {
    async query(sql,args=[]){
     if(sql.startsWith('SELECT pg_try_advisory_lock(')){
      const key=JSON.stringify(args)
      attempted.push(key)
      if(held.has(key))return {rows:[{acquired:false}]}
      held.add(key)
      return {rows:[{acquired:true}]}
     }
     if(sql.startsWith('SELECT pg_advisory_unlock(')){
      const key=JSON.stringify(args)
      const released=held.delete(key)
      return {rows:[{released}]}
     }
     throw Error('Unexpected query: '+sql)
    },
    release(){}
   }
  }
 }
}
test('UAT and Live cannot hold distinct locks on the SAME Caddyfile',async()=>{
 const pool=fakePool()
 await withGatewayLock(pool,options('uat'),async()=>{
  const live=await withGatewayLock(pool,options('live'),async()=>{
   throw Error('Live must never run concurrently')
  })
  assert.equal(live.acquired,false)
 })
 const liveAfter=await withGatewayLock(pool,options('live'),async()=>true)
 assert.equal(liveAfter.acquired,true)
 assert.equal(liveAfter.result,true)
 assert.equal(new Set(pool.attempted).size,1,'Both stages must acquire the SAME advisory key')
})
test('Test also shares the physical writer lock and exceptions release it',async()=>{
 const pool=fakePool()
 await assert.rejects(withGatewayLock(pool,options('test'),async()=>{
  const uat=await withGatewayLock(pool,options('uat'),async()=>{})
  assert.equal(uat.acquired,false)
  throw Error('test failure')
 }),/test failure/)
 const uatAfter=await withGatewayLock(pool,options('uat'),async()=>true)
 assert.equal(uatAfter.acquired,true)
})
test('Failed source CAS cannot arm a stale snapshot rollback watchdog',()=>{
 const script=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 const cas=script.indexOf("if(hash(actual)!==hash(old))throw Error('Another gateway writer changed the Caddy source.')")
 const watcher=script.indexOf("watcher='h5c-release-watch-'")
 assert.ok(cas>0&&watcher>cas,'CAS and fence must pass before watcher starts')
 assert.match(script,/current=\$\(sha256sum \/gateway\/Caddyfile/)
 assert.match(script,/current.*plannedHash/)
 assert.match(script,/refusing unsafe rollback/)
 assert.match(script,/TENANT_RELEASE_ROLLBACK_UNCONFIRMED/)
})

test('Customer Test/UAT cutovers require isolated runtime databases',()=>{
 const script=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 assert.match(script,/async function assertIsolatedStageApi/)
 assert.match(script,/candidateEnv\.DATABASE_URL===productionEnv\.DATABASE_URL/)
 assert.match(script,/candidateEnv\.RUNTIME_ENVIRONMENT!==environment/)
 assert.match(script,/if\(environment!=='live'\)await assertIsolatedStageApi\(plan\.api\)/)
})
test('Central fanout and preview refuse an unprovisioned sandbox',()=>{
 const fanout=readFileSync(new URL('../src/certifiedReleaseFanout.js',import.meta.url),'utf8')
 const preview=readFileSync(new URL('../src/genericReleaseDiscovery.js',import.meta.url),'utf8')
 assert.match(fanout,/uat_environment_status/)
 assert.match(fanout,/row\[plan\.stage\+'_environment_status'\]!=='ready'/)
 assert.match(preview,/sandboxNotReady/)
 assert.match(preview,/status:allowed\?'eligible':sandboxNotReady\?'blocked'/)
})

test('Preflight refuses Caddy source missing an already active tenant route',()=>{
 const script=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 assert.match(script,/const runtimeHosts=new Set/)
 assert.match(script,/Gateway source drift: active tenant route/)
 assert.match(script,/Reconcile before any reload/)
})

test('Stage pool deployment must override Live runtime credentials and secrets',()=>{
 const script=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 assert.match(script,/function stageApiEnvironment\(\)/)
 assert.match(script,/environment\+'_app.url'/)
 assert.match(script,/environment\+'_api_keys.env'/)
 assert.match(script,/Existing non-Live pool retains unsafe or stale runtime credentials/)
 assert.match(script,/key==='HI5_API_SAME_ORIGIN'/)
})

test('Test and Custom UAT pools always reach the canonical Central identity authority',()=>{
 const source=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 const begin=source.indexOf('function stageApiEnvironment(){')
 const end=source.indexOf('function containerEnvironment(',begin)
 assert.ok(begin>=0&&end>begin)
 const declaration=source.slice(begin,end)
 assert.match(declaration,/ENV_IDENTITY_API_URL:'https:\/\/api\.hi5central\.com\/'/)
 assert.match(source,/\s'ENV_IDENTITY_API_URL',/)
 assert.match(source,/Object\.entries\(intended\)\.some\(\(\[key,value\]\)=>environmentNow\[key\]!==value\)/)
 assert.match(source,/Existing non-Live pool retains unsafe or stale runtime credentials/)
})
test('Managed never receives a UAT sandbox or UAT access',async()=>{
 const {tenantSandboxStages}=await import('../src/tenantEnvironmentProvisioner.js')
 assert.deepEqual(tenantSandboxStages('hi5_managed'),['test'])
 assert.deepEqual(tenantSandboxStages('admin_controlled'),['test','uat'])
 const access=readFileSync(new URL('../src/tenantEnvironmentAccess.js',import.meta.url),'utf8')
 const settings=readFileSync(new URL('../src/tenantRelease.js',import.meta.url),'utf8')
 assert.match(access,/rp.update_mode='admin_controlled'/)
 assert.match(access,/Managed customers have Test and Production; UAT is Custom only/)
 assert.match(settings,/row.environment!=='uat'/)
})
