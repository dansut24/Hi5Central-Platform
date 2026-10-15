import assert from 'node:assert/strict'
import test from 'node:test'
import { itsmConfigurationHash, itsmChangedKeys,
  recordItsmConfigurationChange, listItsmConfigurationChanges,
} from '../src/itsmConfigurationChanges.js'

const tenantId='11111111-1111-4111-8111-111111111111'
const actorUserId='22222222-2222-4222-8222-222222222222'
test('Canonical hash ignores JSON property order, detects nested edits',()=>{
  const before={sla:{hours:8,days:5},notifications:true}
  const equivalent={notifications:true,sla:{days:5,hours:8}}
  assert.equal(itsmConfigurationHash(before),itsmConfigurationHash(equivalent))
  const after={notifications:true,sla:{days:5,hours:9}}
  assert.notEqual(itsmConfigurationHash(before),itsmConfigurationHash(after))
  assert.deepEqual(itsmChangedKeys(before,after),['sla'])
})

test('UAT ledger stores no configuration values; skips no-op and Test',async()=>{
  const calls=[]
  const db={query:async(query,params)=>{calls.push({query,params});return {rows:[{id:'id',recorded_at:new Date()}]}}}
  const before={sla:{hours:8},remoteSessionPassword:'do-not-store-this'}
  const after={sla:{hours:9},remoteSessionPassword:'do-not-store-this'}
  const changed=await recordItsmConfigurationChange({db,tenantId,actorUserId,
    environment:'uat',before,after})
  assert.equal(changed.recorded,true)
  assert.deepEqual(changed.changedKeys,['sla'])
  assert.equal(calls.length,1)
  assert.equal(calls[0].params[0],tenantId)
  assert.equal(calls[0].params[1],'uat')
  assert(!JSON.stringify(calls).includes('do-not-store-this'))
  assert.equal((await recordItsmConfigurationChange({db,tenantId,actorUserId,
    environment:'test',before,after})).recorded,false)
  assert.equal((await recordItsmConfigurationChange({db,tenantId,actorUserId,
    environment:'uat',before,after:before})).recorded,false)
  assert.equal(calls.length,1)
})

test('Change listing is tenant/environment scoped and Test is untracked',async()=>{
  const queries=[]
  const db={query:async(sql,values)=>{queries.push(values);return {rows:[{id:'one'}]}}}
  assert.deepEqual(await listItsmConfigurationChanges({db,tenantId,environment:'test'}),[])
  assert.deepEqual(await listItsmConfigurationChanges({db,tenantId,environment:'uat',limit:999}),[{id:'one'}])
  assert.deepEqual(queries,[[tenantId,'uat',100]])
})
