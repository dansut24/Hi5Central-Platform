import assert from 'node:assert/strict'
import test from 'node:test'
import {verifyTenantRouteActivation} from '../src/tenantRouteActivationGate.js'
import {buildTenantRouteCutover} from '../src/tenantRouteCutover.js'

const NOW=new Date('2026-10-15T11:30:00Z')
const OLD='a'.repeat(40),NEW='b'.repeat(40)
const id='11111111-1111-4111-8111-111111111111'
const preference={timezone:'Europe/London',days:['thu'],start:'12:00',end:'14:00'}
const released={sha:NEW,published:true,humanApproved:true,ciPassed:true,
  securityPassed:true,migrationCompatible:true,testSoakMinutes:30,
  managedDelayMinutes:30}
const pool=(env,sha)=>{
  const name='hi5pool-'+env+'-gated-'+(sha===OLD?'old':'new')
  return {
    tenant_id:id,slug:'ci-managed-a',environment:env,
    itsm_entitled:true,update_mode:'hi5_managed',
    pool_id:name,pool_id_verified:name,build_sha:sha,pool_build_sha:sha,
    pool_state:'verified',api_target:name+'-api:3001',web_target:name+'-web:80',
    verified_at:'2026-10-15T11:28:00Z',last_seen_at:'2026-10-15T11:29:00Z',
  }
}
function fixture(env='test',mode='hi5_managed'){
  const tenant={id,mode,status:'active',itsmEntitled:true,
    maintenance:preference,blackouts:[]}
  const job={
    id:'22222222-2222-4222-8222-222222222222',tenant_id:id,
    environment:env,status:'running',build_sha:NEW,
    lease_token:'33333333-3333-4333-8333-333333333333',lease_fence:4,
    scheduled_at:'2026-10-15T11:00:00Z',
    lease_expires_at:'2026-10-15T11:40:00Z',
    expected_duration_minutes:15,
  }
  const old={...pool(env,OLD),update_mode:mode}
  const candidate={...pool(env,NEW),update_mode:mode}
  const plan=buildTenantRouteCutover({tenantId:id,slug:tenant.id?'ci-managed-a':null,
    mode,itsmEntitled:true,environment:env,job,candidate,activeRows:[old],now:NOW})
  const gates={platformPaused:false,hostPoolHealthy:true,
    hostRouteProofReady:true,productionWaveOpen:true,
    test:{sha:NEW,state:'succeeded',completedAt:'2026-10-15T10:00:00Z'},
    uat:{sha:NEW,state:'succeeded',completedAt:'2026-10-15T10:40:00Z'},
    platformTest:{sha:NEW,state:'passed',humanApproved:true,
      passedCanaryCount:2,passedAt:'2026-10-15T10:30:00Z'},
  }
  const args={tenant,job,plan,release:released,gates,
    gatewayObservedSha256:plan.previousManifestSha256,now:NOW}
  return args
}
test('Test route may activate only within real window using exact job, pool and signed-host prerequisites',()=>{
  const good=fixture()
  const ok=verifyTenantRouteActivation(good)
  assert.equal(ok.allowed,true)
  assert.equal(ok.stage,'test')
  assert.equal(ok.beforeSha256,good.plan.previousManifestSha256)
  assert.equal(ok.afterSha256,good.plan.targetManifestSha256)
  assert.equal(verifyTenantRouteActivation({...good,
    job:{...good.job,lease_fence:3}}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...good,
    gates:{...good.gates,platformPaused:true}}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...good,
    gates:{...good.gates,hostPoolHealthy:false}}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...good,
    gatewayObservedSha256:good.plan.targetManifestSha256}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...good,
    tenant:{...good.tenant,status:'suspended'}}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...good,
    release:{...released,humanApproved:false}}).allowed,false)
})
test('No activation can begin when the remaining maintenance duration crosses the window end',()=>{
  const a=fixture()
  const now=new Date('2026-10-15T12:55:00Z')
  const after={...a,now,job:{...a.job,lease_expires_at:'2026-10-15T13:05:00Z'}}
  const value=verifyTenantRouteActivation(after)
  assert.equal(value.allowed,false)
  assert.match(value.reason,/Insufficient time/)
})
test('Customer blackout and unavailable maintenance preference block all releases',()=>{
  const a=fixture()
  const blackout={...a.tenant,blackouts:[{
    startsAt:'2026-10-15T11:40:00Z',endsAt:'2026-10-15T12:00:00Z'}]}
  const value=verifyTenantRouteActivation({...a,tenant:blackout})
  assert.equal(value.allowed,false)
  assert.match(value.reason,/blackout/)
  assert.equal(verifyTenantRouteActivation({...a,tenant:{...a.tenant,
    maintenance:{...preference,days:[]}}}).allowed,false)
})
test('Managed has no UAT route, and Managed Live requires real platform canary evidence',()=>{
  const base=fixture('live')
  assert.equal(verifyTenantRouteActivation(base).allowed,false,'Live is disabled unless explicitly authorised')
  assert.equal(verifyTenantRouteActivation({...base,allowLive:true}).allowed,true)
  assert.equal(verifyTenantRouteActivation({...base,allowLive:true,gates:{...base.gates,
    platformTest:{...base.gates.platformTest,passedCanaryCount:1}}}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...base,allowLive:true,gates:{...base.gates,
    platformTest:{...base.gates.platformTest,passedAt:'2026-10-15T11:25:00Z'}}}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...base,allowLive:true,gates:{...base.gates,
    test:{...base.gates.test,sha:OLD}}}).allowed,false)
  const uat=fixture('uat','admin_controlled')
  assert.equal(verifyTenantRouteActivation({...uat,tenant:{...uat.tenant,
    mode:'hi5_managed'}}).allowed,false)
})
test('Custom UAT follows Test soak; Custom Live demands exact customer sign-off',()=>{
  const uat=fixture('uat','admin_controlled')
  assert.equal(verifyTenantRouteActivation(uat).allowed,true)
  assert.equal(verifyTenantRouteActivation({...uat,gates:{...uat.gates,
    test:{...uat.gates.test,completedAt:'2026-10-15T11:20:00Z'}}}).allowed,false)
  const live=fixture('live','admin_controlled')
  assert.equal(verifyTenantRouteActivation({...live,allowLive:true}).allowed,false)
  const accepted={...live.tenant,uatAcceptance:{
    sha:NEW,approved:true,approvedBy:'customer-owner',approvedAt:'2026-10-15T10:50:00Z'}}
  assert.equal(verifyTenantRouteActivation({...live,tenant:accepted,allowLive:true}).allowed,true)
  assert.equal(verifyTenantRouteActivation({...live,tenant:{...accepted,
    uatAcceptance:{...accepted.uatAcceptance,sha:OLD}},allowLive:true}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...live,tenant:accepted,allowLive:true,
    gates:{...live.gates,uat:{...live.gates.uat,sha:OLD}}}).allowed,false)
  assert.equal(verifyTenantRouteActivation({...live,tenant:accepted,allowLive:true,
    gates:{...live.gates,productionWaveOpen:false}}).allowed,false)
})
