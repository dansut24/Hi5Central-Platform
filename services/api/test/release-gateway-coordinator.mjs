import {test} from 'node:test'
import assert from 'node:assert/strict'
import {withGatewayLock} from '../src/releaseGatewayCoordinator.js'
import {auditFilters as filters} from '../src/platformWorkerAudit.js'

class FakePool{
  constructor(){this.locked=new Set()}
  async connect(){
    const pool=this
    let mine=null
    return {async query(query,params){
      if(query.includes('pg_try_advisory_lock')){
        const resource=params[1]
        if(pool.locked.has(resource))return {rows:[{acquired:false}]}
        pool.locked.add(resource);mine=resource
        return {rows:[{acquired:true}]}
      }
      if(query.includes('pg_advisory_unlock')){
        assert.equal(params[1],mine)
        pool.locked.delete(mine);mine=null
        return {rows:[{released:true}]}
      }
      throw new Error('Unexpected SQL: '+query)
    },release(){assert.equal(mine,null)}}
  }
}
const gate={gateway:'live',workerId:'qa-customer-gateway-1'}
test('two simultaneous customer worker requests serialize on one Production gateway',async()=>{
  const pool=new FakePool()
  let releaseFirst
  let startedFirst
  const firstHasLock=new Promise(resolve=>{startedFirst=resolve})
  const holdFirst=new Promise(resolve=>{releaseFirst=resolve})
  const events=[]
  const first=withGatewayLock(pool,gate,async()=>{
    events.push('tenant-a-start');startedFirst()
    await holdFirst
    events.push('tenant-a-done')
    return 'tenant-a'
  })
  await firstHasLock
  const simultaneous=await withGatewayLock(pool,{...gate,workerId:'qa-customer-gateway-2'},async()=>{
    events.push('UNSAFE-overlap')
  })
  assert.equal(simultaneous.acquired,false)
  assert.match(simultaneous.reason,/another tenant/i)
  assert.deepEqual(events,['tenant-a-start'])
  releaseFirst()
  const firstResult=await first
  assert.equal(firstResult.acquired,true)
  const second=await withGatewayLock(pool,{...gate,workerId:'qa-customer-gateway-2'},async()=>{
    events.push('tenant-b-start');return 'tenant-b'
  })
  assert.equal(second.acquired,true)
  assert.deepEqual(events,['tenant-a-start','tenant-a-done','tenant-b-start'])
})
test('different physical gateways have independently available locks',async()=>{
  const pool=new FakePool()
  let release
  const hold=new Promise(resolve=>release=resolve)
  let started
  const entered=new Promise(resolve=>started=resolve)
  const a=withGatewayLock(pool,gate,async()=>{started();await hold})
  await entered
  const b=await withGatewayLock(pool,{gateway:'uat',workerId:'uat-runner'},async()=>42)
  assert.equal(b.acquired,true)
  release();await a
})
test('audit filters reject invalid tenants and statuses',()=>{
  assert.equal(filters({tenant:'h5c-managed-qa26',environment:'live',limit:'500'}).limit,100)
  assert.throws(()=>filters({status:'arbitrary'}),/Invalid worker status/)
  assert.throws(()=>filters({tenant:"'; DROP TABLE tenants;--"}),/Invalid tenant/)
})
