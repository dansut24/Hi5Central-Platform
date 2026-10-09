import assert from 'node:assert/strict'
import test from 'node:test'
import { suspendedTenantSeed, matchesPreparedIdentity } from '../src/tenantEnvironmentBootstrap.js'

const id1='11111111-1111-4111-8111-111111111111'
const id2='22222222-2222-4222-8222-222222222222'
const id3='33333333-3333-4333-8333-333333333333'
const local='44444444-4444-4444-8444-444444444444'
const request={
  id:id1,tenant_id:id2,request_state:'requested',
  environment:'uat',slug:'acme',hostname_label:'acmeuat',
  company_name:'Acme Ltd',modules:{itsm:true,rmm:true,selfService:true},
  tenant_status:'active',provisioning_status:'pending',
}
const input={ request, environment:'uat',rootDomain:'hi5central.com',databaseInstanceId:id3 }

test('prepares only suspended identity, never credentials, devices, or live RMM capability',()=>{
  const seed=suspendedTenantSeed(input)
  assert.equal(seed.slug,'acme')
  assert.equal(seed.tenantStatus,'suspended')
  assert.deepEqual(seed.modules,{itsm:true,selfService:true,rmm:false})
  assert.deepEqual(seed.urls,{
    tenantUrl:'https://acmeuat.hi5central.com',
    portalUrl:'https://acmeuat-portal.hi5central.com',
    rmmUrl:null,
  })
  assert.equal(seed.expectedHostname,'acmeuat.hi5central.com')
  assert.equal(JSON.stringify(seed).includes('password'),false)
  assert.equal(JSON.stringify(seed).includes('token'),false)
})

test('suspended Test does not accidentally become UAT or Production',()=>{
  const seed=suspendedTenantSeed({
    ...input,environment:'test',
    request:{...request,environment:'test',hostname_label:'acmetest'},
  })
  assert.equal(seed.urls.tenantUrl,'https://acmetest.hi5central.com')
  assert.equal(seed.modules.rmm,false)
})

test('invalid, cancelled, wrong environment or unverified request cannot seed tenant',()=>{
  const scenarios=[
    {request:{...request,request_state:'cancelled'}},
    {request:{...request,tenant_status:'suspended'}},
    {request:{...request,slug:'dev',hostname_label:'devuat'}},
    {request:{...request,hostname_label:'acmetest'}},
    {request:{...request,provisioning_status:'ready'}},
    {environment:'live'},
    {databaseInstanceId:'not-uuid'},
    {request:{...request,modules:null}},
    {request:{...request,company_name:'A'}},
  ]
  for(const change of scenarios)assert.throws(()=>suspendedTenantSeed({...input,...change}),undefined,JSON.stringify(change))
})

test('idempotent target identity matches only exact suspended, provenance-verified records',()=>{
  const seed=suspendedTenantSeed(input)
  const bootstrap={
    control_request_id:id1,control_tenant_id:id2,database_instance_id:id3,
    environment:'uat',expected_hostname:'acmeuat.hi5central.com',
    stage:'identity_prepared',local_tenant_id:local,
  }
  const tenant={id:local,slug:'acme',company_name:'Acme Ltd',status:'suspended'}
  const settings={tenant_url:seed.urls.tenantUrl,portal_url:seed.urls.portalUrl,rmm_url:null,modules:seed.modules}
  assert.equal(matchesPreparedIdentity(seed,bootstrap,tenant,settings),true)
  for (const [b,t,ss] of [
    [{...bootstrap,control_tenant_id:id3},tenant,settings],
    [{...bootstrap,database_instance_id:id2},tenant,settings],
    [{...bootstrap,stage:'ready'},tenant,settings],
    [bootstrap,{...tenant,status:'active'},settings],
    [bootstrap,tenant,{...settings,modules:{...settings.modules,rmm:true}}],
    [bootstrap,tenant,{...settings,tenant_url:'https://acme.hi5central.com'}],
  ])assert.equal(matchesPreparedIdentity(seed,b,t,ss),false)
})
