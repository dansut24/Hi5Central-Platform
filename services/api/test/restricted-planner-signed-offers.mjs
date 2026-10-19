import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const sql=readFileSync(new URL('../migrations/platform-admin/177_planner_customer_signed_offers_rls.sql',import.meta.url),'utf8')
const fanout=readFileSync(new URL('../src/certifiedReleaseFanout.js',import.meta.url),'utf8')

test('restricted scheduler sees only customer-signed UAT and Production offers',()=>{
 assert.match(sql,/CREATE POLICY h5c_release_planner_signed_custom_offers/)
 assert.match(sql,/ON tenant_runtime_update_offers\s+FOR SELECT TO hi5_release_planner/)
 assert.match(sql,/update_mode='admin_controlled'/)
 assert.match(sql,/public\.hi5_release_generic_tenant_permitted\(tenant_id\)=true/)
 assert.match(sql,/environment='uat'[\s\S]*state IN \('uat_accepted','active'\)/)
 assert.match(sql,/uat_accepted_at IS NOT NULL/)
 assert.match(sql,/uat_accepted_by IS NOT NULL/)
 assert.match(sql,/environment='live'[\s\S]*state IN \('scheduled','active'\)/)
 assert.match(sql,/promotion_approved_at IS NOT NULL/)
 assert.match(sql,/promotion_approved_by IS NOT NULL/)
 assert.match(sql,/maintenance_not_before IS NOT NULL/)
 assert.match(sql,/platform_certified_application_releases c/)
 assert.match(sql,/hi5central_published_release_notes n/)
 assert.match(sql,/c\.status='approved'/)
 assert.doesNotMatch(sql,/GRANT (ALL|INSERT|UPDATE|DELETE)|BYPASSRLS|DISABLE ROW LEVEL SECURITY/i)
})
test('the direct-customer planner still requires both matching approvals',()=>{
 assert.match(fanout,/uat\.status!=='succeeded'/)
 assert.match(fanout,/!\['uat_accepted','active'\]\.includes\(uatOffer\.state\)/)
 assert.match(fanout,/!uatOffer\.uat_accepted_at\|\|!uatOffer\.uat_accepted_by/)
 assert.match(fanout,/liveOffer\.state!=='scheduled'/)
 assert.match(fanout,/!liveOffer\.promotion_approved_at/)
 assert.match(fanout,/!liveOffer\.promotion_approved_by/)
 assert.match(fanout,/if\(get\('live'\)\)return \{stage:null/)
 assert.match(fanout,/await enqueueReleasePlans/)
})
