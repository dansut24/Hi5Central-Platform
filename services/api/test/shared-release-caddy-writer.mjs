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
