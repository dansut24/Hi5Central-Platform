import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {planCustomerRouteRollback} from '../../../deployment/release/customer-route-rollback-plan.mjs'
const SHA='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const OLD='a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'
const OTHER='27f2378adccc1a66a84bac5a28a08ebbad835d6b'
const host='companycustom.hi5central.com'
const common=['{','  # shared gateway unchanged','  example.com {',
  '    reverse_proxy shared:8080','  }',
  '  # H5C_RELEASE_ROUTE_BEGIN company.hi5central.com',
  '  @managed host company.hi5central.com',
  '  handle @managed { reverse_proxy hi5pool-live-79d95f3ffa2a-api:3001 }',
  '  # H5C_RELEASE_ROUTE_END company.hi5central.com'].join('\n')
const block=sha=>[
  '  # H5C_RELEASE_ROUTE_BEGIN '+host,
  '  @mytenant host '+host,
  '  handle @mytenant {',
  '    handle /api/* { reverse_proxy hi5pool-live-'+sha.slice(0,12)+'-api:3001 }',
  '    handle { reverse_proxy hi5pool-live-'+sha.slice(0,12)+'-web:80 }',
  '  }',
  '  # H5C_RELEASE_ROUTE_END '+host,
].join('\n')
const base=common+'\n  # H5C_RELEASE_ROUTE_INSERT\n  handle { reverse_proxy api:3001 }\n}'
const active=common+'\n'+block(SHA)+'\n  # H5C_RELEASE_ROUTE_INSERT\n  handle { reverse_proxy api:3001 }\n}'
const oldVersion=common+'\n'+block(OLD)+'\n  # H5C_RELEASE_ROUTE_INSERT\n  handle { reverse_proxy api:3001 }\n}'
const opts={hostname:host,fromBuildSha:SHA,toBuildSha:OLD,
  currentSource:active,previousSource:base}
const hash=v=>createHash('sha256').update(v).digest('hex')
test('rollback restores legacy shared fallback by removing only the named tenant block',()=>{
 const result=planCustomerRouteRollback(opts)
 assert.equal(result.mode,'legacy_shared_fallback')
 assert.equal(result.fromBuildSha,SHA)
 assert.equal(result.toBuildSha,OLD)
 assert.equal(result.currentSourceSha256,hash(active))
 assert.equal(result.previousSnapshotSha256,hash(base))
 assert.equal(result.verifiedUnrelatedRoutesUnchanged,true)
 assert.equal(result.restoredSource.trim(),base.trim())
 assert.ok(result.restoredSource.includes('company.hi5central.com'))
})
test('previous versioned pool restores the old block without changing other tenants',()=>{
 const plan=planCustomerRouteRollback({...opts,previousSource:oldVersion})
 assert.equal(plan.mode,'previous_versioned_pool')
 assert.equal(plan.previousRoutePresent,true)
 assert.equal(plan.restoredSource,oldVersion)
})
test('CAS and backup tampering fail closed before any gateway write',()=>{
 for(const patch of [
  {expectedCurrentGatewayHash:hash('different')},
  {expectedPreviousGatewayHash:hash('different')},
  {currentSource:active.replace('shared:8080','attacker:8080')},
  {previousSource:base.replace('shared:8080','unknown:8080')},
  {currentSource:active.replace('hi5pool-live-79d95f3ffa2a-api:3001','untrusted:3001')},
  {currentSource:base},
  {currentSource:active+'\n'+block(SHA)},
  {currentSource:active.replace('H5C_RELEASE_ROUTE_END '+host,'H5C_RELEASE_ROUTE_END else.hi5central.com')},
  {hostname:'company.hi5central.com'},
  {toBuildSha:SHA},
  {fromBuildSha:'wrong'},
 ])assert.throws(()=>planCustomerRouteRollback({...opts,...patch}),/CUSTOMER_ROLLBACK_ROUTE_DENIED/,
  JSON.stringify(patch).slice(0,140))
})
test('rollback of a legacy route cannot invent a previous versioned block',()=>{
 const invalidPrevious=oldVersion.replaceAll('hi5pool-live-a0504d0bff11',
   'hi5pool-live-'+OTHER.slice(0,12))
 assert.throws(()=>planCustomerRouteRollback({...opts,previousSource:invalidPrevious}),
   /previous snapshot does not route/i)
})
