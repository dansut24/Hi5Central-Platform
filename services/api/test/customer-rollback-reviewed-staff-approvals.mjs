import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {
 reviewedRollbackCompatibilityRequest,reviewedRollbackExecutorRequest,
 reviewedRollbackRevocation,
} from '../src/reviewedCustomerRollbackApprovals.js'
const sha='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'
const old='a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'
const worker='3602c3e2ede5fecb4f311fed02d118780fc44588'
const reason='Reviewed host and backwards-compatibility recovery verified in a completely isolated tenant test.'
const pair={
 confirm:'APPROVE_EXACT_CUSTOM_ROLLBACK_COMPATIBILITY',
 tenantSlug:'companycustom',sourceBuildSha:sha,targetBuildSha:old,
 reason,expiresHours:4,
 evidence:{schemaChecked:true,previousImagePulled:true,recoveryTestPassed:true,
 previousSnapshotSha256:'f'.repeat(64),restoredRouteSha256:'a'.repeat(64),qaRunId:12345},
}
const cert={
 confirm:'CERTIFY_EXACT_CUSTOM_ROLLBACK_EXECUTOR',revisionSha:worker,
 gatewayFenceTested:true,restrictedRoleTested:true,customerOnlyRouteTested:true,
 failureCompensationTested:true,publicVersionVerified:true,
 auditCompletionTested:true,reason,expiresHours:4,
 evidence:{independentHostTest:true,customerIsolationTest:true,
  qaRunId:12345,testedRevisionSha:worker},
}
test('staff signoff is exact-tenant, exact-version, expires within one day, and requires recovery evidence',()=>{
 assert.equal(reviewedRollbackCompatibilityRequest(pair).targetSha,old)
 for(const altered of [
  {confirm:'approved'},{tenantSlug:'x'},{tenantSlug:'Company Test'},
  {sourceBuildSha:'fake'},{targetBuildSha:sha},
  {reason:'yes'},{expiresHours:0},{expiresHours:25},{expiresHours:'4'},
  {evidence:{...pair.evidence,schemaChecked:false}},
  {evidence:{...pair.evidence,previousImagePulled:false}},
  {evidence:{...pair.evidence,recoveryTestPassed:false}},
  {evidence:{...pair.evidence,qaRunId:0}},
  {evidence:{...pair.evidence,previousSnapshotSha256:'bad'}},
 ])assert.throws(()=>reviewedRollbackCompatibilityRequest({...pair,...altered}),
  undefined,JSON.stringify(altered))
})
test('independent rollback worker cannot be certified by just setting a feature switch',()=>{
 assert.equal(reviewedRollbackExecutorRequest(cert).revisionSha,worker)
 for(const altered of [
  {confirm:'yes'},{revisionSha:'bad'},{reason:'short'},
  {expiresHours:26},{expiresHours:'4'},
  {evidence:{...cert.evidence,independentHostTest:false}},
  {evidence:{...cert.evidence,customerIsolationTest:false}},
  {evidence:{...cert.evidence,testedRevisionSha:'a'.repeat(40)}},
  {evidence:{...cert.evidence,qaRunId:-1}},
  ...['gatewayFenceTested','restrictedRoleTested','customerOnlyRouteTested',
  'failureCompensationTested','publicVersionVerified','auditCompletionTested']
   .map(key=>({[key]:false})),
 ])assert.throws(()=>reviewedRollbackExecutorRequest({...cert,...altered}),
  undefined,JSON.stringify(altered))
})
test('staff exact-review revocation requires typed confirmation and reviewer reason',()=>{
 const valid=reviewedRollbackRevocation({
  confirm:'REVOKE_CUSTOM_PRODUCTION_ROLLBACK_REVIEW',type:'executor',
  revisionSha:worker,reason,
 })
 assert.equal(valid.revisionSha,worker)
 assert.throws(()=>reviewedRollbackRevocation({
  confirm:'REVOKE_CUSTOM_PRODUCTION_ROLLBACK_REVIEW',type:'compatibility',
  sourceBuildSha:sha,targetBuildSha:'oops',reason,
 }))
})
test('all staff review routes use existing central owner/admin authority and transactional audit',()=>{
 const api=readFileSync(new URL('../src/releaseWorkActivity.js',import.meta.url),'utf8')
 for(const endpoint of [
  '/api/platform/v1/releases/customer-rollback/review-compatibility',
  '/api/platform/v1/releases/customer-rollback/certify-worker',
  '/api/platform/v1/releases/customer-rollback/revoke-review',
 ]){
  assert.ok(api.includes(endpoint))
 }
 assert.match(api,/const auth=await staffAuthority\(c,deps\)/)
 assert.match(api,/release\.customer_rollback_compatibility_reviewed/)
 assert.match(api,/release\.customer_rollback_executor_certified/)
 assert.match(api,/release\.customer_rollback_review_revoked/)
 assert.match(api,/productionChanged:false/)
 assert.doesNotMatch(api,/app\.post\('\/api\/platform\/v1\/releases\/customer-rollback\/execute'/)
})
