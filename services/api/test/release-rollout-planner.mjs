import assert from 'node:assert/strict'
import test from 'node:test'
import {activeTenantMaintenanceWindow,nextTenantMaintenanceWindow,planReleaseCohort,planTenantRelease} from '../src/releaseRolloutPlanner.js'

const sha='c'.repeat(40)
const now=new Date('2026-10-15T10:00:00Z') // Thursday 11:00 Europe/London
const maintenance={timezone:'Europe/London',days:['thu'],start:'12:00',end:'14:00'}
const release={sha,published:true,humanApproved:true,ciPassed:true,
  securityPassed:true,migrationCompatible:true,publishedAt:'2026-10-15T09:00:00Z',
  testSoakMinutes:30,managedDelayMinutes:30,expectedDeployMinutes:15}
const tenant=(id,mode,extra={})=>({id,mode,itsm:true,status:'active',maintenance,...extra})
const passedTest={sha,state:'succeeded',completedAt:'2026-10-15T09:00:00Z'}
const passedUat={sha,state:'succeeded',completedAt:'2026-10-15T09:35:00Z'}

test('four new QA tenants each receive a unique queued Test deployment, not immediate activation',()=>{
  const tenants=[tenant('qa-managed-1','hi5_managed'),tenant('qa-custom-1','admin_controlled'),
    tenant('qa-managed-2','hi5_managed'),tenant('qa-custom-2','admin_controlled')]
  const rows=planReleaseCohort({tenants,release,now,gates:{}})
  assert.equal(rows.length,4)
  assert(rows.every(row=>row.stage==='test'&&row.status==='scheduled'))
  assert(rows.every(row=>row.scheduledAt==='2026-10-15T11:00:00.000Z'))
  assert.equal(new Set(rows.map(row=>row.idempotencyKey)).size,4)
  assert(rows.every(row=>row.scheduledAt>now.toISOString()))
  assert.throws(()=>planReleaseCohort({tenants:[tenants[0],tenants[0]],release,now}),/Duplicate tenant/)
})
test('post-Test soak sends only Custom to UAT, Managed directly to gated Live',()=>{
  const tenants=[tenant('managed-a','hi5_managed'),tenant('custom-a','admin_controlled')]
  const rows=planReleaseCohort({tenants,release,now,
    gates:{test:passedTest,productionWaveOpen:true}})
  assert.deepEqual(rows.map(row=>row.stage),['live','uat'])
  assert(rows.every(row=>row.status==='scheduled'))
  assert(!rows.some(row=>row.mode==='hi5_managed'&&row.stage==='uat'))
})
test('Custom Live requires exact-build tenant UAT approval; Managed never does',()=>{
  const custom=tenant('custom-b','admin_controlled')
  const gates={test:passedTest,uat:passedUat,productionWaveOpen:true}
  const denied=planTenantRelease({tenant:custom,release,gates,now})
  assert.equal(denied.stage,'live')
  assert.equal(denied.status,'blocked')
  assert.match(denied.reason,/tenant-admin approval/)
  const accepted=planTenantRelease({tenant:{...custom,uatAcceptance:{
    sha,approved:true,approvedBy:'owner-id',approvedAt:'2026-10-15T09:45:00Z'}},release,gates,now})
  assert.equal(accepted.stage,'live')
  assert.equal(accepted.status,'scheduled')
  const wrong=planTenantRelease({tenant:{...custom,uatAcceptance:{
    sha:'d'.repeat(40),approved:true,approvedBy:'owner-id',approvedAt:'2026-10-15T09:45:00Z'}},release,gates,now})
  assert.equal(wrong.status,'blocked')
  const managed=planTenantRelease({tenant:tenant('managed-b','hi5_managed'),release,
    gates:{test:passedTest,productionWaveOpen:true},now})
  assert.equal(managed.stage,'live')
  assert.equal(managed.status,'scheduled')
})
test('a failed Test wave, paused platform or missing approval prevents Production rollout',()=>{
  const managed=tenant('m','hi5_managed')
  assert.equal(planTenantRelease({tenant:managed,release,
    gates:{test:{sha,state:'failed'},productionWaveOpen:true},now}).status,'blocked')
  assert.equal(planTenantRelease({tenant:managed,release,
    gates:{test:passedTest,platformPaused:true,productionWaveOpen:true},now}).status,'blocked')
  assert.equal(planTenantRelease({tenant:managed,release,
    gates:{test:passedTest,productionWaveOpen:false},now}).status,'blocked')
  assert.equal(planTenantRelease({tenant:managed,release:{...release,humanApproved:false},
    gates:{test:passedTest,productionWaveOpen:true},now}).status,'blocked')
})
test('different tenant windows and blackout periods defer each tenant independently',()=>{
  const first=tenant('first','hi5_managed')
  const second=tenant('second','hi5_managed',{maintenance:{
    timezone:'Europe/London',days:['fri'],start:'12:00',end:'14:00'}})
  const third=tenant('third','hi5_managed',{blackouts:[
    {startsAt:'2026-10-15T10:00:00Z',endsAt:'2026-10-15T14:00:00Z'}]})
  const rows=planReleaseCohort({tenants:[first,second,third],release,
    gates:{test:passedTest,productionWaveOpen:true},now})
  assert.equal(rows[0].scheduledAt,'2026-10-15T11:00:00.000Z')
  assert.equal(rows[1].scheduledAt,'2026-10-16T11:00:00.000Z')
  assert.equal(rows[2].scheduledAt,'2026-10-22T11:00:00.000Z')
})
test('DST nonexistent and repeated local wall times resolve to actual UTC instants',()=>{
  const spring=nextTenantMaintenanceWindow({now:'2026-03-29T00:15:00Z',
    policy:{timezone:'Europe/London',days:['sun'],start:'01:30',end:'03:00'},
    notBefore:'2026-03-29T00:15:00Z',durationMinutes:15})
  assert.equal(spring.ok,true)
  assert.equal(spring.scheduledAt,'2026-03-29T01:00:00.000Z') // 02:00 BST, never nonexistent 01:30
  const autumn=nextTenantMaintenanceWindow({now:'2026-10-25T00:15:00Z',
    policy:{timezone:'Europe/London',days:['sun'],start:'01:30',end:'02:30'},
    notBefore:'2026-10-25T00:15:00Z',durationMinutes:15})
  assert.equal(autumn.ok,true)
  assert.equal(autumn.scheduledAt,'2026-10-25T00:30:00.000Z') // first 01:30 occurrence, BST
})
test('invalid windows, missing timezone and invalid blackout must fail closed',()=>{
  assert.equal(nextTenantMaintenanceWindow({now,policy:{days:['thu'],start:'12:00',end:'14:00'}}).ok,false)
  assert.equal(nextTenantMaintenanceWindow({now,policy:{...maintenance,start:'12:00',end:'12:20'}}).ok,false)
  assert.equal(nextTenantMaintenanceWindow({now,policy:maintenance,blackouts:[{startsAt:'bad',endsAt:'bad'}]}).ok,false)
  assert.equal(nextTenantMaintenanceWindow({now,policy:{...maintenance,timezone:'Mars/Olympus'}}).ok,false)
  assert.equal(planTenantRelease({tenant:tenant('paused','hi5_managed'),release:{...release,securityPassed:false},now}).status,'blocked')
})

test('claim-time gate requires full remaining duration and respects actual blackout periods',()=>{
  const inside=activeTenantMaintenanceWindow({policy:maintenance,
    now:'2026-10-15T11:30:00Z',durationMinutes:15})
  assert.equal(inside.allowed,true)
  const overrun=activeTenantMaintenanceWindow({policy:maintenance,
    now:'2026-10-15T12:55:00Z',durationMinutes:15})
  assert.equal(overrun.allowed,false)
  assert.match(overrun.reason,/Insufficient time/)
  const blackout=activeTenantMaintenanceWindow({policy:maintenance,
    now:'2026-10-15T11:30:00Z',durationMinutes:15,blackouts:[
      {startsAt:'2026-10-15T11:42:00Z',endsAt:'2026-10-15T12:00:00Z'}]})
  assert.equal(blackout.allowed,false)
  assert.match(blackout.reason,/blackout/)
  const outside=activeTenantMaintenanceWindow({policy:maintenance,
    now:'2026-10-15T10:59:00Z',durationMinutes:15})
  assert.equal(outside.allowed,false)
  assert.equal(activeTenantMaintenanceWindow({policy:{...maintenance,days:[]},
    now:'2026-10-15T11:30:00Z'}).allowed,false)
  assert.equal(activeTenantMaintenanceWindow({policy:maintenance,
    now:'2026-10-15T11:30:00Z',blackouts:'none'}).allowed,false)
})
