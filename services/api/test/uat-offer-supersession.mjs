import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {retireSupersededUatOffers} from '../src/uatRuntimeOfferSupersession.js'

const tenant='52b02c05-b454-4acc-80cc-90f7adfe0866'
const previous='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const current='654738a065a8b448ca968ac08c7ba429311c5636'

test('retire previous active Custom UAT offer without touching Production or accepted history',async()=>{
 const calls=[]
 const db={async query(sql,params){
   calls.push({sql,params})
   return {rows:[{id:'existing-offer-id',build_sha:previous}],rowCount:1}
 }}
 const result=await retireSupersededUatOffers(db,{tenantId:tenant,buildSha:current})
 assert.equal(result.rowCount,1)
 assert.equal(calls.length,1)
 assert.deepEqual(calls[0].params,[tenant,current])
 assert.match(calls[0].sql,/UPDATE tenant_runtime_update_offers/)
 assert.match(calls[0].sql,/SET state='blocked'/)
 assert.match(calls[0].sql,/environment='uat' AND build_sha<>\$2/)
 assert.match(calls[0].sql,/uat_accepted/)
 assert.match(calls[0].sql,/last_gate_reason=/)
 assert.doesNotMatch(calls[0].sql,/uat_accepted_by\s*=|uat_accepted_at\s*=|promotion_approved_by\s*=/)
})
test('reject invalid identifiers before any UAT offer update',async()=>{
 const db={query(){throw Error('Must not reach SQL')}}
 await assert.rejects(()=>retireSupersededUatOffers(db,{tenantId:'invalid',buildSha:current}),/Exact tenant/)
 await assert.rejects(()=>retireSupersededUatOffers(db,{tenantId:tenant,buildSha:'bad'}),/Exact tenant/)
})
test('same verified worker transaction retires previous UAT offer before replacement insertion',()=>{
 const source=readFileSync(new URL('../src/tenantReleaseExecutor.mjs',import.meta.url),'utf8')
 const begin=source.indexOf('async function persistVerified(')
 const finish=source.indexOf('async function failJob(',begin)
 const body=source.slice(begin,finish)
 const retired=body.indexOf('await retireSupersededUatOffers(tx,')
 const replacement=body.indexOf("'INSERT INTO tenant_runtime_update_offers'")
 assert(begin>=0&&retired>0&&replacement>retired)
 assert.match(body,/if\(gateway==='uat'\)/)
 assert.match(body,/await finishRollout\(tx/)
})
