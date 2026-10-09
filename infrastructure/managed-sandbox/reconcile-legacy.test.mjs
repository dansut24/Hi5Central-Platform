import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileLegacy } from './reconcile-legacy.mjs'

function baseline(){
  const makeProject=(env)=>({
    name:`hi5central-${env}`,
    containers:[
      {service:'control-server',state:'running',tenancyMode:'single',runtimeEnvironment:env,networks:[`hi5central-${env}_hi5internal`]},
      {service:'postgres',state:'running',networks:[`hi5central-${env}_hi5internal`]},
      {service:'redis',state:'running',networks:[`hi5central-${env}_hi5internal`]},
      {service:'gateway',state:'running',networks:['hi5central',`hi5central-${env}_hi5internal`]},
      {service:'itsm-web',state:'running',networks:[`hi5central-${env}_hi5internal`]},
      {service:'rmm-web',state:'running',networks:[`hi5central-${env}_hi5internal`]},
      {service:'turn',state:'running',networks:[`hi5central-${env}_hi5internal`]},
    ],
    routes:[
      {hostname:`${env}-api.hi5central.com`,target:'control-server:3001'},
      {hostname:`${env}.hi5central.com`,target:'itsm-web:80'},
      {hostname:`${env}-rmm.hi5central.com`,target:'rmm-web:80'},
    ],
    volumes:[`hi5central-${env}_postgres_data`,`hi5central-${env}_redis_data`],
  })
  return {
    projects:[makeProject('uat'),makeProject('test')],
    sharedEdgeMembers:['hi5central-uat-gateway','hi5central-test-gateway','hi5central-postgres','hi5central-redis'],
    gatewayEvidenceComplete:true,
    dnsTlsIndependentlyVerified:false,
  }
}

test('existing UAT and Test canonical API hosts conflict with future customer runtimes',()=>{
  const result=reconcileLegacy(baseline(),{tenantSlug:'acme'})
  assert.equal(result.status,'blocked_pending_operator_review')
  assert.equal(result.pilotActivationAllowed,false)
  assert.equal(result.productionChangesAllowed,false)
  assert.equal(result.legacyRemovalAllowed,false)
  for(const env of ['uat','test']){
    assert.equal(result.existing[env].found,true)
    assert.equal(result.existing[env].runtimeMode,'single')
    assert.equal(result.existing[env].hasRmm,true)
    assert.equal(result.existing[env].hasTurn,true)
    assert.equal(result.plans[env].alternateApiClaimed,false)
    assert.equal(result.plans[env].alternateUnpublishedApiOrigin,`https://pilot-${env}-api.hi5central.com`)
    assert.deepEqual(result.plans[env].legacyConflicts.map(x=>x.hostname),[`${env}-api.hi5central.com`])
  }
  assert.ok(result.issues.some(x=>x.includes('SHARED_EDGE_CONTAINS_DATA_SERVICES')))
  assert.ok(result.issues.some(x=>x.includes('DNS_TLS_UNVERIFIED')))
})

test('even if a customer route has no exact collision, DNS/TLS and operator signoff remain blocked',()=>{
  const data=baseline()
  data.projects.forEach(p=>p.routes=[])
  data.sharedEdgeMembers=[]
  data.dnsTlsIndependentlyVerified=true
  const r=reconcileLegacy(data,{tenantSlug:'pilotexample'})
  assert.deepEqual(r.plans.uat.legacyConflicts,[])
  assert.equal(r.pilotActivationAllowed,false)
  assert.equal(r.routeChangesAllowed,false)
})

test('missing legacy evidence, pilot routing conflicts or shared pilot network are never silently accepted',()=>{
  const data=baseline()
  data.projects=data.projects.filter(p=>p.name!=='hi5central-test')
  data.projects[0].routes.push({hostname:'pilot-uat-api.hi5central.com',target:'existing:3001'})
  data.projects[0].containers[0].networks.push('hi5central-sandbox-uat-edge')
  data.sharedEdgeMembers.push('hi5-sandbox-uat-api-1')
  data.gatewayEvidenceComplete=false
  const result=reconcileLegacy(data)
  for(const expected of [
    'UNKNOWN_LEGACY_TEST','PILOT_API_CONFLICT_UAT','PILOT_NETWORK_COLLISION_UAT',
    'GATEWAY_EVIDENCE_INCOMPLETE','PILOT_SHARED_EDGE_VIOLATION'
  ])assert.ok(result.issues.some(x=>x.startsWith(expected)),expected)
  assert.equal(result.pilotActivationAllowed,false)
})

test('only valid UAT and Test plans and reserved-safe customer labels are accepted',()=>{
  const data=baseline()
  assert.throws(()=>reconcileLegacy(data,{environment:'production',tenantSlug:'acme'}))
  assert.throws(()=>reconcileLegacy(data,{environment:'uat',tenantSlug:'dev'}))
  assert.throws(()=>reconcileLegacy(null))
  const single=reconcileLegacy(data,{environment:'test',tenantSlug:'pilotexample'})
  assert.ok(single.plans.test)
  assert.equal(single.plans.uat,undefined)
})
