import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {migrationFileFootprint,summariseMigrationFootprint} from '../src/migrationBaselineEvidence.js'

const f1=migrationFileFootprint({version:'170_customer_scoped_itsm_rollback.sql',
 sourcePath:'platform-admin/170_customer_scoped_itsm_rollback.sql',
 sql:'CREATE TABLE public.tenant_release_upgrade_holds(id uuid); CREATE OR REPLACE FUNCTION public.hi5_reject_held_tenant_live_rollout() RETURNS trigger AS $$ BEGIN RETURN null; END $$ LANGUAGE plpgsql;'})
const f2=migrationFileFootprint({version:'178_independent_customer_rollback_executor_certification.sql',
 sourcePath:'platform-admin/178_independent_customer_rollback_executor_certification.sql',
 sql:'CREATE TABLE platform_release_customer_rollback_executor_certifications(id text);'})
test('source SQL footprint is deterministic and records no migration execution claim',()=>{
 assert.equal(f1.objects.length,2)
 assert.deepEqual(f1.objects[0],{kind:'table',name:'tenant_release_upgrade_holds'})
 assert.deepEqual(f1.objects[1],{kind:'function',name:'hi5_reject_held_tenant_live_rollout'})
 assert.match(f1.sha256,/^[a-f0-9]{64}$/)
})
test('stage-specific report never infers migration execution from objects',()=>{
 const report=summariseMigrationFootprint({
  database:'hi5central_test',ledgerCount:0,files:[f1,f2],
  observed:{table:new Set(['tenant_release_upgrade_holds']),index:new Set(),
   function:new Set(['hi5_reject_held_tenant_live_rollout'])},
 })
 assert.equal(report.status,'HISTORY_UNVERIFIED')
 assert.equal(report.backfillAllowed,false)
 assert.equal(report.appliedHistoryMayBeInferred,false)
 assert.equal(report.historicalObjectRefs,2)
 assert.equal(report.historicalPresent,2)
 assert.equal(report.missingHistorical.length,0)
 assert.equal(report.missingNew.length,1)
})
test('stage differences remain individually visible and cannot be masked by Production',()=>{
 const file=migrationFileFootprint({version:'175_single_managed_live_pilot.sql',
  sourcePath:'platform-admin/175_single_managed_live_pilot.sql',
  sql:'CREATE TABLE platform_release_single_live_pilot_permits(id uuid);'})
 const reporter=observed=>summariseMigrationFootprint({
  database:'hi5central',ledgerCount:0,files:[file],
  observed:{table:new Set(observed),index:new Set(),function:new Set()},
 })
 assert.equal(reporter([]).missingHistorical.length,1)
 assert.equal(reporter(['platform_release_single_live_pilot_permits']).missingHistorical.length,0)
})
test('duplicate history, unexpected identities and malformed source names fail closed',()=>{
 assert.throws(()=>summariseMigrationFootprint({
  database:'hi5central',ledgerCount:0,files:[f1,f1],
  observed:{table:new Set(),index:new Set(),function:new Set()},
 }),/Duplicate migration/)
 assert.throws(()=>migrationFileFootprint({version:'../../oops.sql',sourcePath:'bad',sql:''}))
 assert.throws(()=>summariseMigrationFootprint({
  database:'invalid db',ledgerCount:0,files:[f1],
  observed:{table:new Set(),index:new Set(),function:new Set()},
 }))
})
test('live reporter has read-only transaction and never carries a DDL/DML path',()=>{
 const src=readFileSync(new URL('../src/reportMigrationBaseline.mjs',import.meta.url),'utf8')
 assert.match(src,/BEGIN READ ONLY/)
 assert.match(src,/ROLLBACK/)
 assert.match(src,/!==\'--report\'/)
 assert.doesNotMatch(src,/COMMIT|INSERT INTO|UPDATE public\.schema_migrations|DELETE FROM|CREATE ROLE|ALTER ROLE/)
})
