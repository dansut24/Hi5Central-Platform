import assert from 'node:assert/strict'
import {scheduleTenantLive,scheduledPromotionGate} from '../src/tenantRuntimeReleaseLifecycle.js'
const now=new Date('2026-10-12T02:30:00Z')
const publishedAt=new Date('2026-10-10T01:00:00Z')
const sha='a'.repeat(40)
const tenantId='a1111111-1111-4111-8111-111111111111'
const offerId='b2222222-2222-4222-8222-222222222222'
const userId='c3333333-3333-4333-8333-333333333333'
const pool={id:'hi5pool-live-canary',environment:'live',build_sha:sha,
 state:'verified',api_target:'hi5pool-live-api:3001',web_target:'hi5pool-live-web:80',
 verified_at:now,last_seen_at:now}
const window={timezone:'Europe/London',days:['mon'],start:'02:00',end:'05:00'}
let inserts=0,updates=0,uatLookups=0
function fakeDb({mode='hi5_managed',accepted=false,auto=true,stamp=publishedAt}={}){
 return {async query(sql,args){
   if(sql.includes('FOR UPDATE OF o'))return {rows:[{id:offerId,tenant_id:tenantId,
     pool_id:pool.id,build_sha:sha,environment:'live',state:'offered',
     update_mode:mode,current_mode:mode,live_auto_promote:auto,live_delay_hours:24,
     maintenance_window:window}]}
   if(sql.includes("environment='uat'")&&sql.includes('tenant_runtime_update_offers')){
     uatLookups++;return {rows:accepted?[{build_sha:sha,uat_accepted_at:new Date('2026-10-10T01:00:00Z')}]:[]}
   }
   if(sql.startsWith('SELECT * FROM platform_runtime_pools'))return {rows:[pool]}
   if(sql.startsWith('SELECT published_at FROM hi5central_published_release_notes'))return {rows:[{published_at:stamp}]}
   if(sql.startsWith('UPDATE tenant_runtime_update_offers')){
     updates++;return {rowCount:1,rows:[{id:offerId,environment:'live',build_sha:sha,
       state:'scheduled',maintenance_not_before:args[2]}]}
   }
   if(sql.startsWith('INSERT INTO tenant_runtime_release_events')){
     inserts++;return {rowCount:1,rows:[]}
   }
   throw new Error('Unexpected SQL: '+sql)
 }}
}
const outcome=await scheduleTenantLive({db:fakeDb(),tenantId,offerId,userId:null,now})
assert.equal(outcome.state,'scheduled','Managed can schedule without customer UAT sign-off')
assert.equal(new Date(outcome.maintenance_not_before).getTime(),now.getTime(),
 'Managed delay must be calculated from published timestamp')
assert.equal(updates,1)
assert.equal(inserts,1)
const gate=scheduledPromotionGate({offer:{...outcome,pool_id:pool.id,update_mode:'hi5_managed'},
  preference:{update_mode:'hi5_managed',live_auto_promote:true,live_delay_hours:24,maintenance_window:window},
  uatOffer:null,pool,publishedAt,now})
assert.equal(gate.allowed,true)
assert.equal(gate.reason,'Inside approved maintenance window.')
assert.equal(scheduledPromotionGate({offer:{...outcome,pool_id:pool.id,update_mode:'hi5_managed'},
  preference:{update_mode:'hi5_managed',live_auto_promote:true,live_delay_hours:24,maintenance_window:window},
  uatOffer:null,pool,publishedAt:null,now}).allowed,false,'No publication timestamp: no host activation')
assert.equal(scheduledPromotionGate({offer:{...outcome,pool_id:pool.id,update_mode:'hi5_managed'},
  preference:{update_mode:'hi5_managed',live_auto_promote:true,live_delay_hours:24,
   maintenance_window:{...window,days:['tue']}},
  uatOffer:null,pool,publishedAt,now}).allowed,false,'Outside window must fail closed')
await assert.rejects(
  ()=>scheduleTenantLive({db:fakeDb({mode:'admin_controlled'}),tenantId,offerId,userId,confirmed:true,now}),
  /accepted in UAT first/,'Custom must be denied without a matching UAT approval')
await assert.rejects(
  ()=>scheduleTenantLive({db:fakeDb({mode:'hi5_managed',auto:false}),tenantId,offerId,userId:null,now}),
  /automatic updates are disabled/)
await assert.rejects(
  ()=>scheduleTenantLive({db:fakeDb({mode:'hi5_managed',stamp:new Date('2026-10-13T00:00:00Z')}),tenantId,offerId,userId:null,now}),
  /timestamp is missing or in the future/)
assert.ok(uatLookups>=1)
console.log('PASS: Managed schedules from published release time without UAT, Custom requires accepted UAT; host routing not activated')
