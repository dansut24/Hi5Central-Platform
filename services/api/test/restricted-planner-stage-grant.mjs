import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

test('restricted release scheduler only reads tenant Test/UAT stage readiness',()=>{
 const migration=readFileSync(new URL('../migrations/platform-admin/176_release_planner_stage_status_read.sql',import.meta.url),'utf8')
 assert.match(migration,/GRANT SELECT \(tenant_id,environment,status\)/)
 assert.match(migration,/ON TABLE tenant_environment_state TO hi5_release_planner/)
 assert.match(migration,/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname='hi5_release_planner'\)/)
 assert.doesNotMatch(migration,/GRANT (?:INSERT|UPDATE|DELETE|ALL)\b/)
 const fanout=readFileSync(new URL('../src/certifiedReleaseFanout.js',import.meta.url),'utf8')
 assert.match(fanout,/SELECT e\.status FROM tenant_environment_state e WHERE e\.tenant_id=t\.id AND e\.environment='uat'/)
 assert.match(fanout,/SELECT e\.status FROM tenant_environment_state e WHERE e\.tenant_id=t\.id AND e\.environment='test'/)
 assert.match(fanout,/row\[plan\.stage\+'_environment_status'\]!=='ready'/)
 const worker=readFileSync(new URL('../src/releaseSimpleScheduler.mjs',import.meta.url),'utf8')
 assert.match(worker,/hi5_release_planner/)
 assert.match(worker,/scope:'generic'/)
 assert.match(worker,/deliveryMode:'direct_customer_release'/)
})
