import assert from 'node:assert/strict'
import test from 'node:test'
import {buildTenantRouteCutover,routeCutoverPrecondition} from '../src/tenantRouteCutover.js'

const now=new Date('2026-10-15T11:30:00Z')
const current='a'.repeat(40),next='b'.repeat(40)
const ids=[
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
]
const slugs=['rollout-managed-a','rollout-custom-a','rollout-managed-b','rollout-custom-b']
const mode=['hi5_managed','admin_controlled','hi5_managed','admin_controlled']
const row=(index,sha=current)=>({
  tenant_id:ids[index],slug:slugs[index],itsm_entitled:true,
  update_mode:mode[index],environment:'test',
  pool_id:'hi5pool-test-'+slugs[index]+(sha===next?'-new':'-old'),
  pool_id_verified:'hi5pool-test-'+slugs[index]+(sha===next?'-new':'-old'),
  build_sha:sha,pool_build_sha:sha,pool_state:'verified',
  api_target:'hi5pool-test-'+slugs[index]+(sha===next?'-new':'-old')+'-api:3001',
  web_target:'hi5pool-test-'+slugs[index]+(sha===next?'-new':'-old')+'-web:80',
  verified_at:'2026-10-15T11:28:00Z',
  last_seen_at:'2026-10-15T11:29:00Z',
})
const lease=index=>({
  id:'55555555-5555-4555-8555-555555555555',
  tenant_id:ids[index],environment:'test',build_sha:next,status:'running',
  lease_token:'66666666-6666-4666-8666-666666666666',
  lease_fence:2,scheduled_at:'2026-10-15T11:00:00Z',
  lease_expires_at:'2026-10-15T11:33:00Z',
})
const plan=(index,overrides={})=>buildTenantRouteCutover({
  environment:'test',tenantId:ids[index],slug:slugs[index],
  mode:mode[index],itsmEntitled:true,
  job:lease(index),candidate:row(index,next),
  activeRows:ids.map((_,j)=>row(j)),now,...overrides,
})

test('one tenant route changes and all other assigned tenants remain byte-identical',()=>{
  const p=plan(0)
  assert.equal(p.activationAllowed,false)
  assert.equal(p.noOp,false)
  assert.equal(p.activeTenantCount,4)
  assert.equal(p.targetTenantCount,4)
  assert.equal(p.unchangedOtherTenants,3)
  assert.equal(p.hostname,'rollout-managed-a-test.hi5central.com')
  assert.equal(p.previousRoute.buildSha,current)
  assert.equal(p.targetRoute.buildSha,next)
  assert.equal(p.rollback.sha256,p.previousManifestSha256)
  assert.equal(p.stage.sha256,p.targetManifestSha256)
  assert.deepEqual(p.rollback.entries.filter(e=>e.host!==p.hostname),
    p.stage.entries.filter(e=>e.host!==p.hostname))
  assert.equal(routeCutoverPrecondition({plan:p,
    activeManifestSha256:p.previousManifestSha256,leaseFence:2}).allowed,true)
  assert.equal(routeCutoverPrecondition({plan:p,
    activeManifestSha256:p.targetManifestSha256,leaseFence:2}).allowed,false)
  assert.equal(routeCutoverPrecondition({plan:p,
    activeManifestSha256:p.previousManifestSha256,leaseFence:1}).allowed,false)
})
test('two tenants computed from one snapshot must serialize/replan after the first cutover',()=>{
  const first=plan(0),concurrent=plan(1)
  assert.equal(first.previousManifestSha256,concurrent.previousManifestSha256)
  assert.equal(routeCutoverPrecondition({plan:concurrent,
    activeManifestSha256:first.targetManifestSha256,leaseFence:2}).allowed,false)
  const active=[row(0,next),row(1),row(2),row(3)]
  const newPlan=plan(1,{activeRows:active})
  assert.equal(newPlan.previousManifestSha256,first.targetManifestSha256)
  assert.equal(newPlan.stage.entries.filter(e=>e.buildSha===next).length,2)
  assert.equal(newPlan.unchangedOtherTenants,3)
})
test('new tenant starts with a recorded legacy fallback instead of inventing a previous release',()=>{
  const p=plan(0,{activeRows:[row(1),row(2),row(3)]})
  assert.equal(p.previousRoute,null)
  assert.equal(p.activeTenantCount,3)
  assert.equal(p.targetTenantCount,4)
  assert.equal(p.rollback.entries.length,3)
})
test('invalid or stale jobs, pools, tenants, and Managed UAT are denied',()=>{
  assert.throws(()=>plan(0,{job:{...lease(0),tenant_id:ids[2]}}),/does not match/)
  assert.throws(()=>plan(0,{job:{...lease(0),lease_fence:0}}),/fencing/)
  assert.throws(()=>plan(0,{job:{...lease(0),lease_expires_at:'2026-10-15T11:20:00Z'}}),/valid lease/)
  assert.throws(()=>plan(0,{candidate:{...row(0,next),build_sha:current}}),/must match/)
  assert.throws(()=>plan(0,{candidate:{...row(0,next),api_target:'public.example.com:443'}}),/internal/)
  assert.throws(()=>plan(0,{candidate:{...row(0,next),last_seen_at:'2026-10-15T11:00:00Z'}}),/stale/)
  assert.throws(()=>plan(0,{mode:'hi5_managed',environment:'uat',job:{...lease(0),environment:'uat'}}),/not entitled/)
  assert.throws(()=>plan(0,{itsmEntitled:false}),/not entitled/)
  assert.throws(()=>plan(0,{activeRows:[...ids.map((_,j)=>row(j)),row(0)]}),/duplicate/)
  assert.throws(()=>plan(0,{slug:'another-tenant'}),/must match/)
})
