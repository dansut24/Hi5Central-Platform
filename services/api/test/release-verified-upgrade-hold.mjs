import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {reviewedUpgradeHoldRelease,rollbackPairReady,
  listVerifiedUpgradeHolds,releaseVerifiedUpgradeHold} from '../src/releaseVerifiedUpgradeHold.js'

const tenantId='52b02c05-b454-4acc-80cc-90f7adfe0866'
const admin='ab10952e-dadf-4d24-b340-2f1e3a556a34'
const liveId='361966e9-bfc9-4610-89e1-768f5c35f089'
const uatId='59eb8d86-9461-4326-9e04-7ea86092f03d'
const fromSha='96b9edbcf1631ce9719884c3e3f1700907a6eff0'
const toSha='d05e592ef6e43a494e685f77964b4f9a4eef2c30'
const held='2026-10-20T16:59:49.926Z'
const request={
 tenantSlug:'companycustom',fromBuildSha:fromSha,toBuildSha:toSha,
 productionRollbackId:liveId,uatRollbackId:uatId,holdStartedAt:held,
 confirm:'RELEASE_VERIFIED_PRODUCTION_UPGRADE_HOLD',
 reason:'Verified Production first, then Custom UAT rollback; permit future maintenance-window upgrades.',
}
const proof={
 publicApiSha:toSha,publicWebSha:toSha,otherCustomersUnchanged:true,
 gatewaySourceAndMountMatch:true,
}
const live={
 id:liveId,state:'verified',environment:'live',requested_via:'hi5central_admin',
 source_build_sha:fromSha,target_build_sha:toSha,
 completed_at:'2026-10-20T17:30:57.007Z',proof,
}
const uat={
 id:uatId,state:'verified',environment:'uat',requested_via:'custom_customer',
 source_build_sha:fromSha,target_build_sha:toSha,
 completed_at:'2026-10-20T17:40:24.077Z',proof,
}

function fixture({liveRow=live,uatRow=uat,holdActive=true,
 liveSha=toSha,uatSha=toSha,origin=true,pending=0,offered=0}={}){
 const statements=[]
 let released=false
 let audited=false
 const db={async query(sql,values){
  sql=String(sql);statements.push({sql,values})
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1}
  if(sql.includes('FROM tenants WHERE slug='))return {rows:[{id:tenantId,status:'active'}],rowCount:1}
  if(sql.includes('FROM tenant_release_upgrade_holds')&&sql.includes('FOR UPDATE'))
   return {rows:[{active:holdActive,held_at:new Date(held),requested_by:admin}],rowCount:1}
  if(sql.includes('FROM platform_release_rollback_jobs')&&sql.includes('id IN'))
   return {rows:[liveRow,uatRow].filter(Boolean),rowCount:Number(Boolean(liveRow))+Number(Boolean(uatRow))}
  if(sql.includes("r.created_at=$2 AND r.requested_by=$3"))
   return {rows:origin?[{one:1}]:[],rowCount:origin?1:0}
  if(sql.includes('FROM tenant_runtime_assignments a')){
   const rows=[['live',liveSha,'companycustom.hi5central.com'],['uat',uatSha,'companycustom-uat.hi5central.com']].map(([env,build,host])=>({
    environment:env,build_sha:build,att_sha:build,pool_id:'pool-'+env,
    att_pool:'pool-'+env,state:'active',public_host:host,checked_at:new Date(),
   }))
   return {rows,rowCount:2}
  }
  if(sql.includes('AS rollbacks,'))
   return {rows:[{rollbacks:pending,releases:0,gateway_owners:0,rejected_offers:offered}],rowCount:1}
  if(sql.startsWith('UPDATE tenant_release_upgrade_holds')){
   released=true
   return {rows:[{released_at:new Date()}],rowCount:1}
  }
  throw Error('Unexpected SQL: '+sql.slice(0,220))
 }}
 const audit=async evidence=>{audited=true;assert.equal(evidence.tenantId,tenantId)}
 return {db,statements,audit,get released(){return released},get audited(){return audited}}
}

test('requires exact role-protected confirmation, rollback IDs, build SHAs and reason',()=>{
 assert.deepEqual(reviewedUpgradeHoldRelease(request),request)
 for(const patch of [{confirm:'RELEASE_ANY_HOLD'},{tenantSlug:'other/tenant'},
  {fromBuildSha:toSha},{toBuildSha:fromSha},
  {productionRollbackId:'bad'},{uatRollbackId:liveId},
  {holdStartedAt:'2026-10-20'},{reason:'too short'}]){
  assert.throws(()=>reviewedUpgradeHoldRelease({...request,...patch}),/confirm/)
 }
})

test('verified order and both exact host proofs are mandatory',()=>{
 assert.equal(rollbackPairReady({live,uat,request}),true)
 for(const patch of [{state:'failed'},{requested_via:'custom_customer'},
  {target_build_sha:fromSha},{completed_at:'2026-10-20T17:50:00.000Z'},
  {proof:{...proof,otherCustomersUnchanged:false}}]){
  assert.equal(rollbackPairReady({live:{...live,...patch},uat,request}),false)
 }
 assert.equal(rollbackPairReady({live,uat:{...uat,environment:'live'},request}),false)
 assert.equal(rollbackPairReady({live,uat:{...uat,proof:{...proof,publicWebSha:fromSha}},request}),false)
})

test('exact verified customer hold release is transactional and audit-identified',async()=>{
 const x=fixture()
 const result=await releaseVerifiedUpgradeHold(x.db,request,admin,x.audit)
 assert.equal(result.holdReleased,true)
 assert.equal(result.deploymentsStarted,0)
 assert.equal(x.released,true)
 assert.equal(x.audited,true)
 assert.ok(x.statements.some(x=>x.sql.includes('pg_advisory_xact_lock')))
 assert.ok(x.statements.some(x=>x.sql.includes('WHERE slug=$1 FOR UPDATE')))
 assert.ok(x.statements.some(x=>x.sql.includes('WHERE tenant_id=$1 FOR UPDATE')))
 assert.ok(x.statements.some(x=>x.sql.includes('SET active=false,released_at=now(),released_by=$2')))
 assert.ok(!x.statements.some(x=>x.sql.includes('UPDATE tenant_runtime_assignments')))
 assert.ok(!x.statements.some(x=>x.sql.includes('INSERT INTO tenant_release_rollout_jobs')))
})

test('fail closed on missing proofs, active jobs, mismatched assignments, rejected still-offered build',async()=>{
 for(const options of [{holdActive:false},{origin:false},{liveRow:null},{uatRow:null},
  {liveSha:fromSha},{uatSha:fromSha},{pending:1},{offered:1}]){
  const x=fixture(options)
  await assert.rejects(()=>releaseVerifiedUpgradeHold(x.db,request,admin,x.audit))
  assert.equal(x.released,false,JSON.stringify(options))
  assert.equal(x.audited,false,JSON.stringify(options))
 }
 const x=fixture()
 await assert.rejects(()=>releaseVerifiedUpgradeHold(x.db,request,'not-authenticated',x.audit))
 assert.equal(x.released,false)
})

test('read-only list exposes only active held tenants and exact approved restore candidates',async()=>{
 const db={async query(sql){
  assert.match(sql,/WHERE h.active=true/)
  assert.doesNotMatch(sql,/FOR UPDATE|UPDATE tenant_release_upgrade_holds/)
  return {rows:[{
   slug:'companycustom',held_at:new Date(held),live_id:liveId,uat_id:uatId,
   from_sha:fromSha,to_sha:toSha,live_completed:new Date(live.completed_at),
   uat_completed:new Date(uat.completed_at),production_sha:toSha,uat_sha:toSha,
   pending_recovery:false,
  }]}
 }}
 const holds=await listVerifiedUpgradeHolds(db)
 assert.equal(holds.length,1)
 assert.equal(holds[0].canRequest,true)
 assert.equal(holds[0].productionRollbackId,liveId)
})

test('admin API and page wire authenticated hold release with audit and explicit user confirmation',()=>{
 const api=readFileSync(new URL('../src/releaseWorkActivity.js',import.meta.url),'utf8')
 const ui=readFileSync(new URL('../../../apps/admin/src/features/admin/ReleaseWorkActivity.jsx',import.meta.url),'utf8')
 assert.match(api,/app.post\('\/api\/platform\/v1\/releases\/rollback\/upgrade-holds\/release'/)
 assert.match(api,/const auth=await staffAuthority\(c,deps\)/)
 assert.match(api,/release\.customer_production_upgrade_hold_released/)
 assert.match(api,/withTransaction\(async db=>releaseVerifiedUpgradeHold/)
 assert.match(ui,/RELEASE_VERIFIED_PRODUCTION_UPGRADE_HOLD/)
 assert.match(ui,/window.confirm\('Release the Production upgrade hold/)
})
