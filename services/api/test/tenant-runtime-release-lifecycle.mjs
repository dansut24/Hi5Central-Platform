import assert from 'node:assert/strict'
import {validateUatAcceptance,verifiedCustomerRoute,scheduledPromotionGate,
 acceptTenantUat} from '../src/tenantRuntimeReleaseLifecycle.js'

const sha='a'.repeat(40),now=new Date('2026-10-12T02:30:00Z')
const accepted={notes:'UAT login, incidents, tasks and mobile checks all passed with valid permissions.',
 checks:['login','navigation','records','mobile']}
assert.deepEqual(validateUatAcceptance(accepted),accepted)
assert.throws(()=>validateUatAcceptance({...accepted,checks:['login']}),/four/)
assert.throws(()=>validateUatAcceptance({...accepted,notes:'too short'}),/20/)
const uatPool={id:'hi5pool-uat-canary',environment:'uat',state:'verified',build_sha:sha,
 api_target:'hi5pool-uat-canary-api:3001',web_target:'hi5pool-uat-canary-web:80',
 last_seen_at:new Date(now.getTime()-60000),verified_at:new Date(now.getTime()-60000)}
const route={pool_id:uatPool.id,environment:'uat',state:'active',build_sha:sha,
 public_host:'testing-uat.hi5central.com',checked_at:new Date(now.getTime()-60000)}
const uatOffer={environment:'uat',pool_id:uatPool.id,build_sha:sha}
const routeStatus=(r=route,p=uatPool,o=uatOffer)=>verifiedCustomerRoute({
 route:r,pool:p,offer:o,slug:'testing',now})
assert.equal(routeStatus().ok,true)
assert.equal(routeStatus({...route,state:'rolled_back'}).ok,false)
assert.equal(routeStatus({...route,public_host:'test2-uat.hi5central.com'}).ok,false)
assert.equal(routeStatus({...route,build_sha:'b'.repeat(40)}).ok,false)
assert.equal(routeStatus({...route,checked_at:new Date(now.getTime()-910000)}).ok,false)
assert.equal(routeStatus(route,{...uatPool,last_seen_at:new Date(now.getTime()-910000)}).ok,false)
const livePool={...uatPool,id:'hi5pool-live-1',environment:'live',api_target:'hi5pool-live-1-api:3001',web_target:'hi5pool-live-1-web:80'}
const liveOffer={environment:'live',pool_id:livePool.id,build_sha:sha,state:'scheduled',
 update_mode:'hi5_managed',maintenance_not_before:new Date(now.getTime()-1000)}
const approved={state:'uat_accepted',build_sha:sha,uat_accepted_at:'2026-10-10T01:00:00Z'}
const managed={update_mode:'hi5_managed',live_auto_promote:true,live_delay_hours:24,
 maintenance_window:{timezone:'Europe/London',days:['mon'],start:'02:00',end:'05:00'}}
const platformTest={state:'passed',build_sha:sha,passed_at:'2026-10-10T01:00:00Z',
 passed_canary_count:2}
const gate=(o=liveOffer,p=managed,u=approved,l=livePool,time=now,quality=platformTest)=>scheduledPromotionGate({
 offer:o,preference:p,uatOffer:u,testGate:quality,pool:l,now:time})
assert.equal(gate().allowed,true)
assert.equal(gate(liveOffer,managed,null).allowed,true,'Managed requires Test, never UAT')
assert.equal(gate(liveOffer,managed,approved,livePool,now,null).allowed,false,'Missing platform Test signoff blocks Managed')
assert.equal(gate(liveOffer,{...managed,live_auto_promote:false}).allowed,false)
assert.equal(gate(liveOffer,{...managed,update_mode:'admin_controlled'}).allowed,false)
assert.equal(gate(liveOffer,managed,{...approved,build_sha:'b'.repeat(40)}).allowed,true,'Managed ignores unrelated UAT offers')
assert.equal(gate(liveOffer,managed,approved,livePool,now,{...platformTest,build_sha:'b'.repeat(40)}).allowed,false)
assert.equal(gate({...liveOffer,maintenance_not_before:new Date(now.getTime()+60000)}).allowed,false)
assert.equal(gate(liveOffer,{...managed,live_delay_hours:72}).allowed,false)
assert.equal(gate(liveOffer,{...managed,maintenance_window:{...managed.maintenance_window,days:['tue']}}).allowed,false)
const custom={...liveOffer,update_mode:'admin_controlled'}
assert.equal(gate(custom,{update_mode:'admin_controlled',maintenance_window:managed.maintenance_window},approved).allowed,false)
assert.equal(gate({...custom,promotion_approved_at:now,promotion_approved_by:'user-1'},{
 update_mode:'admin_controlled',maintenance_window:managed.maintenance_window},approved).allowed,true)

const ids=['a1111111-1111-4111-8111-111111111111',
 'b2222222-2222-4222-8222-222222222222',
 'c3333333-3333-4333-8333-333333333333']
let writes=0
const db={async query(sql,parameters){
 if(sql.includes('FOR UPDATE OF o'))return {rows:[{
  id:ids[1],tenant_id:ids[0],slug:'testing',state:'uat_testing',
  environment:'uat',pool_id:uatPool.id,build_sha:sha,pool_id_verified:uatPool.id,
  pool_environment:uatPool.environment,pool_build_sha:sha,pool_state:'verified',
  api_target:uatPool.api_target,web_target:uatPool.web_target,
  verified_at:uatPool.verified_at,last_seen_at:uatPool.last_seen_at,
  route_pool_id:route.pool_id,route_build_sha:sha,public_host:route.public_host,
  route_state:'active',route_environment:'uat',checked_at:route.checked_at,
 }],rowCount:1}
 writes++
 if(sql.startsWith('UPDATE'))return {rows:[{id:ids[1],state:'uat_accepted',build_sha:sha}],rowCount:1}
 return {rows:[],rowCount:1}
}}
const updated=await acceptTenantUat({db,tenantId:ids[0],offerId:ids[1],userId:ids[2],
 evidence:accepted,now})
assert.equal(updated.state,'uat_accepted')
assert.equal(writes,2)
console.log('PASS: customer UAT acceptance tied to attested tenant and build; managed windows and customer approvals fail closed')
