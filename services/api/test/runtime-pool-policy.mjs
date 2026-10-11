import assert from 'node:assert/strict'
import { maintenanceWindowStatus,verifiedRuntimePool,tenantReleaseEligibility,resolvedCustomerPool,customerPoolHostname } from '../src/runtimePoolPolicy.js'

const sha='a'.repeat(40)
const now=new Date('2026-10-12T02:30:00.000Z') // Monday BST: 03:30
const pool={id:'pool-uat-a',environment:'uat',build_sha:sha,state:'verified',
  api_target:'hi5-pool-api:3001',web_target:'hi5-pool-web:80',
  verified_at:new Date(now.getTime()-60_000).toISOString(),
  last_seen_at:new Date(now.getTime()-60_000).toISOString()}
const livePool={...pool,id:'pool-live-a',environment:'live'}
const policy={timezone:'Europe/London',days:['mon'],start:'02:00',end:'05:00'}
const managed={update_mode:'hi5_managed',live_delay_hours:24,maintenance_window:policy}
const custom={update_mode:'admin_controlled',maintenance_window:policy}
assert.equal(maintenanceWindowStatus(policy,now).allowed,true)
assert.equal(maintenanceWindowStatus({...policy,days:['tue']},now).allowed,false)
assert.equal(maintenanceWindowStatus({...policy,timezone:'Not/AZone'},now).allowed,false)
assert.equal(maintenanceWindowStatus({...policy,start:'12:00',end:'12:00'},now).allowed,false)
assert.equal(maintenanceWindowStatus({timezone:'UTC',days:['sun'],start:'23:00',end:'03:00'},
  new Date('2026-10-12T01:00:00Z')).allowed,true)
assert.equal(maintenanceWindowStatus({timezone:'UTC',days:['mon'],start:'23:00',end:'03:00'},
  new Date('2026-10-12T01:00:00Z')).allowed,false)
assert.equal(verifiedRuntimePool(pool,now).verified,true)
assert.equal(verifiedRuntimePool({...pool,state:'provisioning'},now).verified,false)
assert.equal(verifiedRuntimePool({...pool,last_seen_at:new Date(now.getTime()-900_001)},now).verified,false)
assert.equal(verifiedRuntimePool({...pool,api_target:'evil.com:3001'},now).verified,false)
assert.equal(tenantReleaseEligibility({preference:custom,pool,environment:'uat',published:true,now}).state,'available_in_uat')
assert.equal(tenantReleaseEligibility({preference:custom,pool:livePool,environment:'live',published:true,now}).state,'awaiting_uat')
assert.equal(tenantReleaseEligibility({preference:custom,pool:livePool,environment:'live',published:true,uatAccepted:true,now}).state,'ready_for_customer_approval')
assert.equal(tenantReleaseEligibility({preference:managed,pool:livePool,environment:'live',published:true,uatAccepted:true,uatAcceptedAt:'2026-10-12T00:00:00Z',now}).state,'pending_delay')
assert.equal(tenantReleaseEligibility({preference:managed,pool:livePool,environment:'live',published:true,uatAccepted:true,uatAcceptedAt:'2026-10-10T00:00:00Z',now}).state,'eligible_for_scheduled_update')
assert.equal(tenantReleaseEligibility({preference:managed,pool:{...livePool,last_seen_at:'2026-10-12T09:59:00Z'},environment:'live',published:true,uatAccepted:true,uatAcceptedAt:'2026-10-10T00:00:00Z',now:new Date('2026-10-12T10:00:00Z')}).state,'pending_maintenance')
assert.equal(tenantReleaseEligibility({preference:managed,pool:livePool,environment:'live',published:false,uatAccepted:true,now}).state,'unreleased')
assert.equal(resolvedCustomerPool({assignment:null,pool:null,environment:'live',now}).route,'legacy')
const assignment={pool_id:pool.id,build_sha:sha,environment:'uat'}
assert.equal(resolvedCustomerPool({assignment,pool,environment:'uat',generationActive:true,now}).route,'pool')
assert.equal(resolvedCustomerPool({assignment,pool,environment:'uat',generationActive:false,now}).route,'blocked')
assert.equal(resolvedCustomerPool({assignment,pool:{...pool,build_sha:'b'.repeat(40)},environment:'uat',generationActive:true,now}).route,'blocked')
assert.equal(customerPoolHostname('testing','uat'),'testing-uat.hi5central.com')
assert.equal(customerPoolHostname('testing','live'),'testing.hi5central.com')
assert.throws(()=>customerPoolHostname('bad.name','live'),/Invalid tenant hostname/)
console.log('PASS: version pool verification, tenant rollback guard, managed windows and customer-controlled UAT')
