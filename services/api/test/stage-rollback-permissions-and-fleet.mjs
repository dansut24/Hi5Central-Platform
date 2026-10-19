import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {
 rollbackPermission,rollbackIntent,staffRollbackSelection,
 rollbackReadiness,RELEASE_ROLLBACK_STAGE,
} from '../src/stageRollbackControl.js'
import {
 validateStageRollbackLease,assertTenantOnlyGatewayMutation,
} from '../src/stageRollbackExecution.mjs'
import {prepareSharedTenantCaddyRoute} from '../src/tenantCaddyVersionRoutes.js'

const from='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const to='a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'
const reason='The last application version failed regression tests, restore previous verified build.'
const request={environment:'uat',fromBuildSha:from,toBuildSha:to,
 routeGeneration:1792412068014,reason,confirm:'ROLLBACK_MY_CUSTOM_UAT'}
test('Custom customer rollback is UAT only, never Production or Test',()=>{
 for(const stage of ['live','test','unknown',null]){
  assert.equal(rollbackPermission({actor:'customer',mode:'admin_controlled',environment:stage}),false)
 }
 assert.equal(rollbackPermission({actor:'customer',mode:'admin_controlled',environment:'uat'}),true)
 for(const mode of ['hi5_managed','missing',null])
  assert.equal(rollbackPermission({actor:'customer',mode,environment:'uat'}),false)
 assert.throws(()=>rollbackIntent({...request,environment:'live'}, {actor:'customer'}),
  /Customers may roll back Custom UAT only/)
 assert.throws(()=>rollbackIntent({...request,confirm:'ROLLBACK_MY_CUSTOM_PRODUCTION'}, {actor:'customer'}),
  /Explicit authorised/)
 assert.equal(rollbackIntent(request,{actor:'customer'}).environment,'uat')
})
test('Hi5Central staff may individually restore Custom UAT, or one/all Production',()=>{
 assert.deepEqual([...RELEASE_ROLLBACK_STAGE].sort(),['live','uat'])
 assert.equal(rollbackPermission({actor:'platform_admin',mode:'hi5_managed',environment:'live'}),true)
 assert.equal(rollbackPermission({actor:'platform_admin',mode:'admin_controlled',environment:'live'}),true)
 assert.equal(rollbackPermission({actor:'platform_admin',mode:'admin_controlled',environment:'uat'}),true)
 assert.equal(rollbackPermission({actor:'platform_admin',mode:'hi5_managed',environment:'uat'}),false)
 assert.deepEqual(staffRollbackSelection({
  scope:'all',environment:'live',confirm:'HI5CENTRAL_ROLLBACK_CONFIRMED',reason,
 }),{scope:'all',environment:'live',reason,tenantSlug:null})
 assert.throws(()=>staffRollbackSelection({
  scope:'all',environment:'uat',confirm:'HI5CENTRAL_ROLLBACK_CONFIRMED',reason,
 }),/Production fleet/)
 assert.throws(()=>staffRollbackSelection({
  scope:'all',environment:'live',tenantSlug:'companycustom',
  confirm:'HI5CENTRAL_ROLLBACK_CONFIRMED',reason,
 }),/must not also specify/)
})
test('all stage-rollback requests pin exact verified source SHA, old SHA and route generation',()=>{
 const parsed=rollbackIntent(request,{actor:'customer'})
 assert.equal(parsed.fromSha,from)
 assert.equal(parsed.toSha,to)
 for(const modified of [
  {fromBuildSha:to},{toBuildSha:from},{toBuildSha:'foo'},
  {routeGeneration:0},{routeGeneration:'1792412068014'},
  {reason:'bad'},
 ]){
  assert.throws(()=>rollbackIntent({...request,...modified},{actor:'customer'}))
 }
})
const job={id:'11111111-1111-4111-8111-111111111111',
 tenantId:'22222222-2222-4222-8222-222222222222',
 originalJobId:'33333333-3333-4333-8333-333333333333',
 leaseToken:'44444444-4444-4444-8444-444444444444',
 tenantSlug:'companycustom',environment:'uat',fromSha:from,toSha:to,
 generation:1792412068014,leaseFence:1}
test('existing stage executor refuses cross-stage and forged lease',()=>{
 assert.equal(validateStageRollbackLease(job,'uat').environment,'uat')
 for(const x of [
  {environment:'live'},{tenantSlug:'../../foo'},{leaseToken:'bad'},
  {generation:0},{leaseFence:0},{toSha:from},{originalJobId:'invalid'},
 ]){
  assert.throws(()=>validateStageRollbackLease({...job,...x},'uat'))
 }
})
test('pure Caddy rollback routing cannot modify any other tenant',()=>{
 const config=':443 {\n  # H5C_RELEASE_ROUTE_INSERT\n}\n'
 const first=prepareSharedTenantCaddyRoute({
  config,tenantSlug:'companymanaged',environment:'live',buildSha:from})
 const second=prepareSharedTenantCaddyRoute({
  config:first.config,tenantSlug:'companycustom',environment:'uat',buildSha:from})
 const after=prepareSharedTenantCaddyRoute({
  config:second.config,tenantSlug:'companycustom',environment:'uat',buildSha:to})
 assert.equal(assertTenantOnlyGatewayMutation({
  before:second.config,after:after.config,
  host:'companycustom-uat.hi5central.com',
 }),true)
 assert.throws(()=>assertTenantOnlyGatewayMutation({
  before:second.config,after:after.config.replace('companymanaged','tampered'),
  host:'companycustom-uat.hi5central.com',
 }),/Another customer/)
})
test('customer API contains no Production rollback submission and preserves Live release centre auth',()=>{
 const source=readFileSync(new URL('../src/tenantRelease.js',import.meta.url),'utf8')
 assert.match(source,/body\?\.environment!=='uat'/)
 assert.match(source,/ROLLBACK_MY_CUSTOM_UAT/)
 assert.match(source,/actor:'customer'/)
 assert.doesNotMatch(source,/requestCustomerRollback\(/)
 assert.doesNotMatch(source,/ROLLBACK_MY_CUSTOM_PRODUCTION/)
 assert.match(source,/requireTenantAdmin\(c\)/)
})
test('staff API limits recovery writes to central owner/admin with per-tenant audited jobs',()=>{
 const source=readFileSync(new URL('../src/releaseWorkActivity.js',import.meta.url),'utf8')
 assert.match(source,/\/api\/platform\/v1\/releases\/rollback\/request/)
 assert.match(source,/staffAuthority\(c,deps\)/)
 assert.match(source,/release\.platform_rollback_queued/)
 assert.match(source,/for\(const row of selected\)/)
 assert.match(source,/await withTransaction\(async db=>/)
 assert.match(source,/H5C_STAGE_ROLLBACK_QUEUE_READY/)
})
test('stage worker and host use existing physical lock, per-stage DB lease and public verification',()=>{
 const runner=readFileSync(new URL('../src/tenantReleaseExecutor.mjs',import.meta.url),'utf8')
 const host=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 const execution=readFileSync(new URL('../src/stageRollbackExecution.mjs',import.meta.url),'utf8')
 const sql=readFileSync(new URL('../migrations/platform-admin/182_stage_rollback_worker_fences.sql',import.meta.url),'utf8')
 assert.match(runner,/H5C_STAGE_ROLLBACK_EXECUTOR_ENABLED==='true'/)
 assert.match(runner,/processQueuedStageRollback/)
 assert.match(execution,/pg_try_advisory_lock\(hashtext\(\$1\),hashtext\(\$2\)\)/)
 assert.match(execution,/hi5_stage_rollback_claim/)
 assert.match(execution,/hi5_stage_rollback_complete/)
 assert.match(execution,/hi5_stage_rollback_fail/)
 assert.match(execution,/assertTenantOnlyGatewayMutation/)
 assert.match(execution,/publicVersion\(shell,hostname\)/)
 assert.match(host,/H5C_STAGE_ROLLBACK_WORKER/)
 assert.match(host,/H5C_ROLLBACK_REQUEST_ID/)
 assert.match(sql,/session_user=\('hi5_release_executor_'\|\|p_stage\)/)
 assert.match(sql,/hi5_stage_rollback_session_ok/)
 assert.match(sql,/GRANT EXECUTE ON FUNCTION/)
 assert.doesNotMatch(sql,/GRANT\s+(?:ALL|UPDATE|INSERT|DELETE)\s+ON\s+(?:TABLE)/)
})

test('customer UAT readiness is read-only and disabled until the real executor is ready',async()=>{
 const tenantId='22222222-2222-4222-8222-222222222222'
 const queries=[]
 const db={query:async(sql)=>{
   queries.push(sql)
   if(sql.includes('SELECT t.status,p.update_mode'))
     return {rows:[{status:'active',update_mode:'admin_controlled'}]}
   if(sql.includes('SELECT id,state,source_build_sha'))
     return {rows:[]}
   if(sql.includes('SELECT a.build_sha,a.generation,a.pool_id'))
     return {rows:[{build_sha:from,generation:1792412068014,pool_id:'h5pool-uat-'+from.slice(0,12),slug:'companycustom'}]}
   if(sql.includes('SELECT j.previous_build_sha'))
     return {rows:[{previous_build_sha:to}]}
   throw Error('Unexpected query '+sql)
 }}
 const r=await rollbackReadiness(db,{tenantId,environment:'uat',actor:'customer',executorReady:false})
 assert.equal(r.canRequest,false)
 assert.match(r.reasons.join(' '),/executor is disabled/)
 assert.equal(r.environment,'uat')
 assert.equal(r.installedBuildSha,from)
 assert.equal(r.previousBuildSha,to)
 assert.ok(queries.every(sql=>/^SELECT/.test(sql.trim())))
 assert.ok(queries.every(sql=>!sql.includes('FOR UPDATE')))
})
test('Managed customer is never shown a UAT rollback even if an executor is enabled',async()=>{
 const db={query:async(sql)=>{
  if(sql.includes('SELECT t.status,p.update_mode'))
   return {rows:[{status:'active',update_mode:'hi5_managed'}]}
  throw Error('Managed customer readiness must stop before querying tenant private rollback state')
 }}
 const result=await rollbackReadiness(db,{
  tenantId:'22222222-2222-4222-8222-222222222222',
  actor:'customer',environment:'uat',executorReady:true,
 })
 assert.equal(result.canRequest,false)
})
test('staff Production rollback establishes tenant upgrade hold; UAT never holds Live upgrades',()=>{
 const source=readFileSync(new URL('../src/stageRollbackControl.js',import.meta.url),'utf8')
 assert.match(source,/if\(intent.environment==='live'\)\{/)
 assert.match(source,/INSERT INTO tenant_release_upgrade_holds/)
 assert.match(source,/tenant_release_upgrade_holds.active=false/)
 assert.match(source,/An existing Production upgrade hold/)
 assert.match(source,/return \{\.\.\.job,tenantSlug/)
})
