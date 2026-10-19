import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {generateKeyPairSync,sign} from 'node:crypto'
import {
 TARGETS,ROLLBACK_SQL,canonicalJson,sha256,validateSignedBaseline,
 captureSchemaFingerprint,SCHEMA_QUERIES,
} from '../src/reviewedBaselineMigration.js'

const {publicKey:reviewer,privateKey:reviewerSecret}=generateKeyPairSync('ed25519')
const {publicKey:dba,privateKey:dbaSecret}=generateKeyPairSync('ed25519')
const sha='347409aae59819e72a3d4bdff4f31b3526809ff9'
const priorWorker='ee7dbfcd0871bcadfd854d0cb8742e7b7693e4ec'
const hashes=ROLLBACK_SQL.map((_,n)=>String(n+1).repeat(64))
const instant=new Date('2026-10-19T19:00:00Z')
const payload={
 version:1,purpose:'custom-customer-rollback-178-180',stage:'live',
 database:'hi5central',schemaFingerprint:'a'.repeat(64),
 publicTableCount:216,previousLedgerRows:0,
 sourceCommit:sha,workerRevisionSha:priorWorker,
 backupPath:'/opt/hi5central/recovery/approved/central-20261019.dump',
 backupSha256:'b'.repeat(64),backupRestored:true,
 schemaEquivalenceReviewed:true,stageIsolationReviewed:true,
 historyUnverifiedAcknowledged:true,customerRoutesMustRemainUnchanged:true,
 rollbackWorkerMustRemainDisabled:true,
 reviewerId:'11111111-1111-4111-8111-111111111111',
 dbaReviewerId:'22222222-2222-4222-8222-222222222222',
 reason:'Named independent staff review of exact restored schema, backup and controlled rollback migrations.',
 reviewedAt:'2026-10-19T18:00:00Z',expiresAt:'2026-10-19T21:00:00Z',
 migrations:ROLLBACK_SQL.map((name,i)=>({name,sha256:hashes[i]})),
}
const signed=p=>{
 const bytes=Buffer.from(canonicalJson(p),'utf8')
 return {payload:p,
  reviewerSignature:sign(null,bytes,reviewerSecret).toString('base64'),
  dbaSignature:sign(null,bytes,dbaSecret).toString('base64')}
}
function check(p,keys={}){
 return validateSignedBaseline({
  envelope:signed(p),reviewerPublicKey:keys.reviewer||reviewer,
  dbaPublicKey:keys.dba||dba,now:instant,
  database:'hi5central',baselineFingerprint:'a'.repeat(64),
  publicTableCount:216,workerRevisionSha:priorWorker,
  migrationHashes:hashes,sourceCommit:sha,
 })
}
test('two distinct Ed25519 reviewer signatures bind exact migration hashes and restore proof',()=>{
 const validated=check(payload)
 assert.equal(validated.stage,'live')
 assert.equal(validated.sourceCommit,sha)
 assert.equal(validated.migrations.length,3)
 assert.match(validated.attestationSha256,/^[a-f0-9]{64}$/)
 assert.notEqual(validated.reviewerKeyFingerprint,validated.dbaKeyFingerprint)
 assert.equal(TARGETS.uat,'hi5central_uat')
})
test('tampered, missing or single-signer review never passes',()=>{
 const valid=signed(payload)
 const tampered=structuredClone(valid)
 tampered.payload.sourceCommit='c'.repeat(40)
 for(const envelope of [
  tampered,{payload,reviewerSignature:valid.reviewerSignature},
  {...valid,dbaSignature:valid.reviewerSignature},
  {...valid,reviewerSignature:'a'.repeat(88)},
 ]){
  assert.throws(()=>validateSignedBaseline({
   envelope,reviewerPublicKey:reviewer,dbaPublicKey:dba,now:instant,
   database:'hi5central',baselineFingerprint:'a'.repeat(64),
   publicTableCount:216,workerRevisionSha:priorWorker,
   migrationHashes:hashes,sourceCommit:sha,
  }),/BASELINE_APPROVAL_DENIED/)
 }
 assert.throws(()=>check(payload,{dba:reviewer}),/two separate Ed25519/)
})
test('all stage, schema, backup, timing and scope mismatches are denied even if signed',()=>{
 const changes=[
  {stage:'uat'},{database:'hi5central_dev'},{schemaFingerprint:'d'.repeat(64)},
  {publicTableCount:215},{previousLedgerRows:1},{sourceCommit:'e'.repeat(40)},
  {workerRevisionSha:'e'.repeat(40)},
  {backupPath:'/etc/passwd'},{backupPath:'/opt/hi5central/recovery/../secret'},
  {backupSha256:'bad'},{backupRestored:false},
  {schemaEquivalenceReviewed:false},{stageIsolationReviewed:false},
  {historyUnverifiedAcknowledged:false},
  {customerRoutesMustRemainUnchanged:false},{rollbackWorkerMustRemainDisabled:false},
  {reviewerId:payload.dbaReviewerId},{dbaReviewerId:payload.reviewerId},
  {reviewedAt:'2026-10-20T00:00:00Z'},
  {expiresAt:'2026-10-19T18:55:00Z'},
  {expiresAt:'2026-10-20T00:00:00Z'},
  {migrations:payload.migrations.slice(0,2)},
  {migrations:payload.migrations.map((x,i)=>i===0?{...x,name:'001_init.sql'}:x)},
  {migrations:payload.migrations.map((x,i)=>i===2?{...x,sha256:'f'.repeat(64)}:x)},
 ]
 for(const modification of changes){
  assert.throws(()=>check({...payload,...modification}),/BASELINE_APPROVAL_DENIED/,
   JSON.stringify(modification))
 }
})
test('stable source and schema canonicalisation cannot depend on object insertion order',()=>{
 assert.equal(canonicalJson({b:2,a:1}),canonicalJson({a:1,b:2}))
 assert.equal(sha256(canonicalJson({b:2,a:{z:1,y:2}})),
  sha256(canonicalJson({a:{y:2,z:1},b:2})))
 assert.throws(()=>canonicalJson({bad:()=>{}}),/BASELINE_APPROVAL_DENIED/)
})
test('catalogue fingerprint uses schema, grants, policies, constraints and functions but never tenant rows',async()=>{
 assert.ok(Object.keys(SCHEMA_QUERIES).length>=8)
 const visited=[]
 const fake={query:async sql=>{
  visited.push(sql)
  return {rows:sql===SCHEMA_QUERIES.tables
   ?[{tablename:'tenant_release_rollout_jobs'}]
   :[{object_name:'a',object_definition:'b'}]}
 }}
 const proof=await captureSchemaFingerprint(fake)
 assert.equal(proof.tableCount,1)
 assert.equal(visited.length,Object.keys(SCHEMA_QUERIES).length)
 assert.equal(proof.fingerprint.length,64)
 for(const sql of visited){
  assert.match(sql,/^(SELECT)/)
  assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b(?:\s+TABLE|\s+FROM|\s+public)/)
 }
})
test('operator runner has no historical ledger write and no automatic worker activation',()=>{
 const source=readFileSync(new URL('../src/reviewedBaselineMigrationRunner.mjs',import.meta.url),'utf8')
 assert.match(source,/--inspect/)
 assert.match(source,/--preflight/)
 assert.match(source,/--apply/)
 assert.match(source,/H5C_REVIEWED_BASELINE_APPLY/)
 assert.match(source,/hi5_release_migration_operator/)
 assert.match(source,/row\.rolsuper!==false/)
 assert.match(source,/row\.rolbypassrls!==false/)
 assert.match(source,/SELECT pg_advisory_xact_lock/)
 assert.match(source,/platform_reviewed_baseline_migration_receipts/)
 assert.match(source,/actual_migrations jsonb NOT NULL/)
 assert.match(source,/schemaFingerprint:schema\.fingerprint/)
 assert.match(source,/verifyBackup/)
 assert.match(source,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/)
 assert.doesNotMatch(source,/INSERT INTO (?:public\.)?schema_migrations/)
 assert.doesNotMatch(source,/UPDATE (?:public\.)?schema_migrations/)
 assert.doesNotMatch(source,/ALTER ROLE hi5_release_rollback_executor.*LOGIN/)
})
