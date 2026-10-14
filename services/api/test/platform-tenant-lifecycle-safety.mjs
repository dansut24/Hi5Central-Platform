import {test} from 'node:test'
import assert from 'node:assert/strict'
import {checkLifecycleConfirmation,purgeEligible} from '../src/platformTenantLifecycle.js'

const slug='h5c-custom-qa26'
const reason='Authorised lifecycle request under retention policy.'
const valid={confirmSlug:slug,reason}
test('lifecycle changes require exact tenant confirmation and a recorded reason',()=>{
  const r=checkLifecycleConfirmation('suspend',slug,valid)
  assert.equal(r.reason,reason)
  for(const body of [{reason}, {...valid,confirmSlug:'h5c-managed-qa26'},
    {...valid,reason:'short'}, {...valid,reason:'x'.repeat(601)}]){
    assert.throws(()=>checkLifecycleConfirmation('archive',slug,body))
  }
  assert.throws(()=>checkLifecycleConfirmation('delete-database',slug,valid),/Unknown/)
})
test('archives cannot shorten the mandatory 30-day restore interval',()=>{
  assert.equal(checkLifecycleConfirmation('archive',slug,valid).days,30)
  assert.equal(checkLifecycleConfirmation('archive',slug,{...valid,retentionDays:365}).days,365)
  for(const days of [0,1,29,366,30.5,-7,'nan']){
    assert.throws(()=>checkLifecycleConfirmation('archive',slug,{...valid,retentionDays:days}),/30–365/)
  }
})
test('a purge request needs a second explicit typed confirmation',()=>{
  assert.throws(()=>checkLifecycleConfirmation('request-purge',slug,valid),/PURGE/)
  assert.throws(()=>checkLifecycleConfirmation('request-purge',slug,
    {...valid,purgeConfirmation:'PURGE h5c-managed-qa26'}),/PURGE/)
  assert.equal(checkLifecycleConfirmation('request-purge',slug,
    {...valid,purgeConfirmation:'PURGE '+slug}).reason,reason)
})
test('permanent purge eligibility requires expired retention, export and no legal hold',()=>{
  const deadline='2026-10-10T00:00:00Z'
  const now=new Date('2026-10-13T12:00:00Z')
  const opts={state:'archived',deadline,legalHold:false,exportCompleted:true,now}
  assert.equal(purgeEligible(opts),true)
  assert.equal(purgeEligible({...opts,state:'active'}),false)
  assert.equal(purgeEligible({...opts,state:'purge_requested'}),false)
  assert.equal(purgeEligible({...opts,legalHold:true}),false)
  assert.equal(purgeEligible({...opts,exportCompleted:false}),false)
  assert.equal(purgeEligible({...opts,deadline:'2026-10-20T00:00:00Z'}),false)
  assert.equal(purgeEligible({...opts,deadline:null}),false)
})
