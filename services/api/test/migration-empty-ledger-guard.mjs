import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {assertHistoricalMigrationLedgerSafe, assertMigrationHistoryPrefixSafe} from '../src/migrationLedgerSafety.js'
test('empty populated Production schema may not replay historical migration files',()=>{
 assert.throws(()=>assertHistoricalMigrationLedgerSafe({appliedCount:0,publicTableCount:216}),
  /MIGRATION_HISTORY_UNVERIFIED/)
 assert.throws(()=>assertHistoricalMigrationLedgerSafe({appliedCount:0,publicTableCount:213}),
  /MIGRATION_HISTORY_UNVERIFIED/)
})
test('genuinely empty fresh database can bootstrap its migration ledger',()=>{
 assert.deepEqual(assertHistoricalMigrationLedgerSafe({appliedCount:0,publicTableCount:0}),
  {safeToProceed:true,freshDatabase:true})
})
test('already tracked migration ledger is not reinitialised',()=>{
 assert.deepEqual(assertHistoricalMigrationLedgerSafe({appliedCount:175,publicTableCount:216}),
  {safeToProceed:true,freshDatabase:false})
})
test('invalid schema probes never authorise migration replay',()=>{
 for(const bad of [
  {appliedCount:-1,publicTableCount:216},
  {appliedCount:null,publicTableCount:216},
  {appliedCount:0,publicTableCount:NaN},
  {appliedCount:0,publicTableCount:-1},
  {appliedCount:0.5,publicTableCount:216},
 ]){
  assert.throws(()=>assertHistoricalMigrationLedgerSafe(bad),/invalid schema counts/)
 }
})
test('a partial ledger with only 178–180 recorded cannot replay missing historical schema',()=>{
 const ordered=['001_initialize.sql','120_auth.sql','177_review.sql','178_cert.sql','179_claim.sql','180_complete.sql']
 assert.throws(()=>assertMigrationHistoryPrefixSafe({
  appliedVersions:['178_cert.sql','179_claim.sql','180_complete.sql'],
  sourceVersions:ordered,
 }),/MIGRATION_HISTORY_UNVERIFIED/)
 assert.throws(()=>assertMigrationHistoryPrefixSafe({
  appliedVersions:['001_initialize.sql','177_review.sql'],
  sourceVersions:ordered,
 }),/MIGRATION_HISTORY_UNVERIFIED/)
})
test('complete historical prefix followed by newer pending migrations is valid',()=>{
 const ordered=['001_initialize.sql','120_auth.sql','177_review.sql','178_cert.sql','179_claim.sql','180_complete.sql']
 assert.deepEqual(assertMigrationHistoryPrefixSafe({
  appliedVersions:ordered.slice(0,3),sourceVersions:ordered,
 }),{safeToProceed:true,appliedCount:3})
 assert.throws(()=>assertMigrationHistoryPrefixSafe({
  appliedVersions:['999_missing.sql'],sourceVersions:ordered,
 }),/source unavailable/)
})
test('runner checks real schema prior to enumerating and applying SQL',()=>{
 const src=readFileSync(new URL('../src/migrate.js',import.meta.url),'utf8')
 const ledger=src.indexOf("const applied = new Set")
 const probe=src.indexOf("const baseline = await client.query(")
 const guard=src.indexOf("assertHistoricalMigrationLedgerSafe({")
 const files=src.indexOf("const files = await migrationFiles()")
 const prefix=src.indexOf('assertMigrationHistoryPrefixSafe({')
 const write=src.indexOf("await client.query('BEGIN')")
 assert.ok(ledger>=0&&ledger<probe&&probe<guard&&guard<files&&files<prefix&&prefix<write)
 assert.match(src,/public_table_count/)
 assert.match(src,/schema_migrations/)
})
