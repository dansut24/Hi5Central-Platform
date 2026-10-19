import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {validatedRollbackClaim,assertOtherTenantVersions}
 from '../src/customerProductionRollbackWorker.mjs'
import {planCustomerRouteRollback} from '../../../deployment/release/customer-route-rollback-plan.mjs'

const current='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const prior='a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'
const revision='3602c3e2ede5fecb4f311fed02d118780fc44588'
const claim={
 requestId:'12345678-1234-4234-8234-123456789012',
 tenantId:'45678901-1234-4234-8234-123456789012',
 originalJobId:'1e53479b-7c36-44d7-8bda-656955db7027',
 leaseToken:'78901234-1234-4234-8234-123456789012',
 slug:'companycustom',host:'companycustom.hi5central.com',
 sourceSha:current,targetSha:prior,generation:1792412068014,
 poolId:'h5pool-live-79d95f3ffa2a',
 snapshot:'release-live-1792412065513-companycustom-hi5central-com',
 leaseFence:1,workerRevision:revision,
}
test('only exact signed customer request, source pool, host, recovery snapshot and lease can be consumed',()=>{
 assert.equal(validatedRollbackClaim(claim,revision).host,claim.host)
 for(const part of [
  {host:'company.hi5central.com'}, {slug:'company'},
  {host:'bad.example.com'},{sourceSha:'a'.repeat(40)},
  {targetSha:current},{sourceSha:'abc'},{targetSha:'abc'},
  {generation:0},{leaseFence:0},{leaseToken:'spoof'},
  {requestId:'bad'},{tenantId:'bad'},{originalJobId:'bad'},
  {workerRevision:'a'.repeat(40)}, {poolId:'h5pool-live-a0504d0bff11'},
  {snapshot:'../../etc/passwd'},
  {snapshot:'release-live-1792412065513-company-hi5central-com'},
 ]){
  assert.throws(()=>validatedRollbackClaim({...claim,...part},revision),
   /Untrusted rollback claim/,JSON.stringify(part))
 }
})
test('independent public version check fails on another tenant API OR frontend drift',()=>{
 const before={
  'companycustom.hi5central.com':{api:current,web:current},
  'company.hi5central.com':{api:current,web:current},
  'companymanaged.hi5central.com':{api:prior,web:prior},
 }
 assert.equal(assertOtherTenantVersions(before,{
  ...before,'companycustom.hi5central.com':{api:prior,web:prior},
 },'companycustom.hi5central.com'),true)
 for(const change of [
  {'company.hi5central.com':{api:prior,web:current}},
  {'company.hi5central.com':{api:current,web:prior}},
  {'companymanaged.hi5central.com':{api:current,web:prior}},
  {'company.hi5central.com':null},
 ]){
  assert.throws(()=>assertOtherTenantVersions(before,{...before,...change},claim.host),
   /Another tenant changed/)
 }
})
const migration=n=>readFileSync(new URL('../migrations/platform-admin/'+n,import.meta.url),'utf8')
const worker=readFileSync(new URL('../src/customerProductionRollbackWorker.mjs',import.meta.url),'utf8')
test('the new dedicated role has no LOGIN or customer table write privilege',()=>{
 const sql=migration('179_restricted_customer_rollback_worker_claim.sql')
 assert.match(sql,/CREATE ROLE hi5_release_rollback_executor NOLOGIN NOINHERIT/)
 assert.match(sql,/session_user='hi5_release_rollback_executor'/)
 assert.match(sql,/hi5central-release-gateway/)
 assert.match(sql,/hi5central-release-claim/)
 assert.match(sql,/FOR UPDATE SKIP LOCKED/)
 assert.match(sql,/state='requested'/)
 assert.match(sql,/h.active|t.active/)
 assert.match(sql,/from_build_sha=q.source_build_sha/)
 assert.match(sql,/approved/)
 assert.match(sql,/EXCEPTION/)
 assert.match(sql,/GRANT EXECUTE ON FUNCTION/)
 assert.doesNotMatch(sql,/GRANT\s+(ALL|INSERT|UPDATE|DELETE)\s+ON\s+TABLE/i)
 assert.doesNotMatch(sql,/\bBYPASSRLS\b|\bSUPERUSER\b|CREATE ROLE[^\n]*\sLOGIN(?:\s|;)/i)
})
test('rollback completion requires public API+frontend plus customer isolation, retains tenant hold',()=>{
 const sql=migration('180_restricted_customer_rollback_completion.sql')
 for(const evidence of [
  'publicApiSha','publicWebSha','otherCustomersUnchanged',
  'uatUnchanged','gatewaySourceAndMountMatch',
  'previousSnapshotSha256','restoredRouteSha256',
  'sourceRouteGeneration','priorImagesHealthy',
  'hi5_customer_rollback_assert_fence','customer_self_service_live_rollback_verified',
 ]){
  assert.ok(sql.includes(evidence),evidence)
 }
 assert.match(sql,/status='rolled_back'/)
 assert.match(sql,/state='verified'/)
 assert.match(sql,/state=CASE WHEN p_source_restored THEN 'failed' ELSE 'running' END/)
 assert.doesNotMatch(sql,/DELETE FROM public\.tenant_release_upgrade_holds/)
 assert.doesNotMatch(sql,/UPDATE public\.tenant_release_upgrade_holds SET active=false/)
})
test('host worker fail-closed, gateway-fenced, backup-isolated, with crash watchdog',()=>{
 for(const evidence of [
  "ROLLBACK_WORKER_ACTIVE==='true'",
  "hi5_release_rollback_executor",
  "hi5_customer_rollback_claim($1)",
  "hi5_customer_rollback_assert_fence($1,$2,$3,$4)",
  "hi5_customer_rollback_complete($1,$2,$3,$4,$5::jsonb)",
  "hi5_customer_rollback_fail($1,$2,$3,$4,$5,$6)",
  'pg_try_advisory_lock','pg_advisory_unlock','snapshotCurrentSource',
  'assertNoGatewayRuntimeDrift','planCustomerRouteRollback',
  'assertOtherTenantVersions','ensureOldBuildHealthy','validateCandidate',
  'startWatchdog','finishWatchdog','ensureServing','rollbackPlan.restoredSourceSha256',
 ]){
  assert.ok(worker.includes(evidence),evidence)
 }
 assert.match(worker,/if\(MODE==='--preflight'\)/)
 assert.match(worker,/CUSTOMER_ROLLBACK_RESTRICTED_WORKER_PREFLIGHT_PASS_NO_WRITES/)
 assert.doesNotMatch(worker,/ROLLBACK_WORKER_ACTIVE\s*=\s*true|CREATE ROLE|ALTER ROLE/)
})
test('existing pure tenant-only route CAS planner remains reusable',()=>{
 assert.equal(typeof planCustomerRouteRollback,'function')
})
