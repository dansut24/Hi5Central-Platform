import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {planCustomerRouteRollback} from '../../../deployment/release/customer-route-rollback-plan.mjs'
const source=readFileSync(new URL('../../../deployment/release/operator-custom-live-rollback-drill-20261019.mjs',import.meta.url),'utf8')
test('one-off review pins only Custom Production exact tenant, job, build pair and preserved gateway snapshots',()=>{
 for(const text of [
  "slug:'companycustom'","host:'companycustom.hi5central.com'",
  "job:'1e53479b-7c36-44d7-8bda-656955db7027'",
  "old:'a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'",
  "current:'79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'",
  "generation:1792412068014",
  "backup:'release-live-1792412065513-companycustom-hi5central-com'",
  "currentCaddy:'f6da381780c251f3b89ba8ee74fc502b51b486ca82303a69db42e0433416938f'",
  "previousCaddy:'067b20b8d63e81eeccba050eb697175bd1a97c63df25cf79ef53f60efce9daa9'",
 ])assert.ok(source.includes(text),text)
 assert.ok(source.includes("process.argv.length!==3"))
 assert.ok(source.includes("if(!APPLY)"))
})
test('host execution enforces session gateway mutex, claim transaction, customer row lock and route proof',()=>{
 assert.match(source,/pg_try_advisory_lock\(hashtext\('hi5central-release-gateway'\)/)
 assert.match(source,/pg_advisory_xact_lock\(hashtext\('hi5central-release-claim'\)/)
 assert.match(source,/FOR UPDATE OF t/)
 assert.match(source,/route\.rows\[0\]\.public_host===EXPECT\.host/)
 assert.match(source,/generation\)===EXPECT\.generation/)
 assert.match(source,/planCustomerRouteRollback\(/)
 assert.match(source,/previousSnapshotSha256/)
 assert.match(source,/customerSelfServiceRequestUsed:false/)
 assert.match(source,/activeCustomerUpgradeHoldCreated:false/)
})
test('requires public version proof and compensates on failure without modifying other customer data',()=>{
 assert.match(source,/publicApiAndFrontendVerified:true/)
 assert.match(source,/for\(const \[host,v\] of Object\.entries\(before\)\)/)
 assert.match(source,/if\(host===EXPECT\.host\)continue/)
 assert.match(source,/if\(!committed&&routeApplied\)/)
 assert.match(source,/cancelWatch\(\)/)
 assert.match(source,/CRITICAL_GATEWAY_RESCUE_WATCHDOG_RETAINED/)
 assert.match(source,/sourceRouteGeneration/)
 assert.match(source,/UPDATE tenant_runtime_update_offers/)
 assert.match(source,/status='rolled_back'/)
 assert.doesNotMatch(source,/UPDATE platform_release_rollout_control|DELETE FROM tenants|DROP TABLE|INSERT INTO tenant_release_customer_rollback_requests/)
})
test('separate reviewed customer route planner is used to restore previous legacy fallback',()=>{
 assert.equal(typeof planCustomerRouteRollback,'function')
 assert.match(source,/mode==='legacy_shared_fallback'/)
 assert.match(source,/plan\.restoredSource===previous/)
})
