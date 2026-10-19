#!/usr/bin/env node
/**
 * EXACTLY THREE reviewed rollback-control migrations, NO historical backfill.
 *
 * --inspect (read-only): print source SQL hashes + live schema fingerprint.
 * --preflight /abs/review.json (read-only): verify 2 independent signatures.
 * --apply /abs/review.json (explicit): requires the established database
 * owner/DBA session, protected host trust anchors,
 * checked/recoverable backup and signed approval for THIS DB/SHA.
 *
 * There is NO automated invocation from CI/Dev/container startup.
 */
import pg from 'pg'
import {readFileSync,createReadStream,realpathSync,statSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {
 TARGETS,ROLLBACK_SQL,sha256,captureSchemaFingerprint,
 validateSignedBaseline,
} from './reviewedBaselineMigration.js'

const mode=process.argv[2]||'--inspect'
if(!['--inspect','--preflight','--apply'].includes(mode)
 ||(mode==='--inspect'&&process.argv.length!==3)
 ||(mode!=='--inspect'&&(process.argv.length!==4||!process.argv[3]?.startsWith('/'))))
 throw Error('Usage: reviewedBaselineMigrationRunner.mjs --inspect | --preflight /absolute/signed-review.json | --apply /absolute/signed-review.json')
if(!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL||''))
 throw Error('A scoped PostgreSQL DATABASE_URL is required.')
const sourceDir=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const migrationDir=join(sourceDir,'services/api/migrations/platform-admin')
const shaCheck=/^[0-9a-f]{40}$/
function gitCommit(){
 const r=spawnSync('git',['-C',sourceDir,'rev-parse','HEAD'],{encoding:'utf8',timeout:6000})
 if(r.status!==0||!shaCheck.test(r.stdout.trim()))
   throw Error('Reviewable immutable checkout SHA unavailable.')
 const status=spawnSync('git',['-C',sourceDir,'status','--porcelain','--untracked-files=no'],{encoding:'utf8',timeout:6000})
 if(status.status!==0||status.stdout.trim())
   throw Error('Reviewed migration checkout contains uncommitted tracked changes.')
 return r.stdout.trim()
}
function sqlInputs(){
 return ROLLBACK_SQL.map(name=>{
  const sql=readFileSync(join(migrationDir,name),'utf8')
  return {name,sha256:sha256(sql),sql}
 })
}
function loadSignedEnvelope(file){
 const path=realpathSync(file)
 if(path!==file||!path.endsWith('.json'))throw Error('Review file must be a directly mounted absolute JSON file.')
 const s=statSync(path)
 if(!s.isFile()||s.size>24000||(s.mode&0o077)!==0)
   throw Error('Approved review file must be a private regular file, maximum 24 KB.')
 return JSON.parse(readFileSync(path,'utf8'))
}
const REVIEWER_KEY='/etc/hi5central/migration-review/staff-ed25519.pub.pem'
const DBA_KEY='/etc/hi5central/migration-review/dba-ed25519.pub.pem'
function readTrustedKey(path){
 const actual=realpathSync(path)
 if(actual!==path)throw Error('A trusted approval key must not be a symlink.')
 const stat=statSync(path)
 if(!stat.isFile()||stat.uid!==0||(stat.mode&0o022)!==0)
   throw Error('Trusted reviewer key is not root-owned and write-protected.')
 return readFileSync(path)
}
async function verifyBackup(path,expectedSha){
 if(!path.startsWith('/opt/hi5central/recovery/')||path.includes('..'))
   throw Error('Untrusted backup path outside the reviewed private recovery area.')
 const absolute=realpathSync(path)
 if(absolute!==path)throw Error('Backup symlink denied.')
 const meta=statSync(path)
 if(!meta.isFile()||meta.uid!==0||(meta.mode&0o077)!==0||meta.size<1024)
   throw Error('Backup must be root-only, non-empty and independently recoverable.')
 const hash=createHash('sha256')
 await new Promise((ok,fail)=>{
  const stream=createReadStream(path)
  stream.on('data',data=>hash.update(data))
  stream.on('end',ok)
  stream.on('error',fail)
 })
 if(hash.digest('hex')!==expectedSha)throw Error('Previously restored recovery backup checksum differs.')
}
async function readDbState(db){
 const result=await db.query([
  'SELECT current_database() AS database,session_user AS session_user,',
  'current_user AS current_user,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcanlogin',
  'FROM pg_roles r WHERE r.rolname=session_user',
 ].join(' '))
 const row=result.rows[0]
 if(!row||!Object.values(TARGETS).includes(row.database))
   throw Error('Not an explicitly supported Hi5Central stage database.')
 const ledger=await db.query('SELECT count(*)::int AS total FROM public.schema_migrations')
 const historical=Number(ledger.rows[0]?.total)
 if(historical!==0)throw Error('Baseline-only tool requires a fully untracked existing schema; never replay or backfill history.')
 const existing=await db.query([
  "SELECT to_regclass('public.platform_release_customer_rollback_executor_certifications') AS cert,",
  "to_regclass('public.platform_reviewed_baseline_migration_receipts') AS receipt,",
  "to_regrole('hi5_release_rollback_executor') AS worker",
 ].join(' '))
 const objects=existing.rows[0]
 if(objects?.cert!==null||objects?.receipt!==null||objects?.worker!==null)
   throw Error('Rollback schema, migration receipt, or worker role already exists; manual reconciliation required.')
 const schema=await captureSchemaFingerprint(db)
 if(schema.tableCount<100)throw Error('Unexpected empty or incomplete Hi5Central schema.')
 return {row,ledgerCount:historical,schema}
}
async function perform(){
 const sources=sqlInputs(),commit=gitCommit()
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  connectionTimeoutMillis:6000,statement_timeout:45000})
 await db.connect()
 let transaction=false
 try{
  await db.query(mode==='--apply'?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  transaction=true
  if(mode==='--apply'){
   if(process.env.H5C_REVIEWED_BASELINE_APPLY!=='true')
    throw Error('Migration executor is OFF: separate platform activation required.')
   await db.query('SELECT pg_advisory_xact_lock($1)',[48554321])
  }
  const {row,ledgerCount,schema}=await readDbState(db)
  const workerSha=process.env.H5C_CUSTOMER_ROLLBACK_WORKER_SHA||''
  if(!shaCheck.test(workerSha)&&mode!=='--inspect')
   throw Error('Pin the exact immutable customer rollback worker revision.')
  const audit={database:row.database,stage:Object.keys(TARGETS).find(x=>TARGETS[x]===row.database),
   sourceCommit:commit,schemaFingerprint:schema.fingerprint,
   publicTableCount:schema.tableCount,previousLedgerRows:ledgerCount,
   reviewedMigrations:sources.map(x=>({name:x.name,sha256:x.sha256})),
   historicalLedgerUnchanged:true,rollbackWorkerStillDisabled:true}
  if(mode==='--inspect'){
   console.log(JSON.stringify({result:'UNVERIFIED_BASELINE_FINGERPRINT_ONLY',...audit},null,2))
   await db.query('ROLLBACK');transaction=false;return
  }
  const envelope=loadSignedEnvelope(process.argv[3])
  const reviewerKey=readTrustedKey(REVIEWER_KEY)
  const dbaKey=readTrustedKey(DBA_KEY)
  const approval=validateSignedBaseline({
   envelope,reviewerPublicKey:reviewerKey,dbaPublicKey:dbaKey,
   database:row.database,baselineFingerprint:schema.fingerprint,
   publicTableCount:schema.tableCount,sourceCommit:commit,
   workerRevisionSha:workerSha,migrationHashes:sources.map(x=>x.sha256),
  })
  await verifyBackup(approval.backupPath,approval.backupSha256)
  if(mode==='--preflight'){
   console.log(JSON.stringify({result:'SIGNED_BASELINE_PREFLIGHT_PASS_NO_WRITES',
    ...audit,approvalSha256:approval.attestationSha256,
    reviewerKeyFingerprint:approval.reviewerKeyFingerprint,
    dbaKeyFingerprint:approval.dbaKeyFingerprint},null,2))
   await db.query('ROLLBACK');transaction=false;return
  }
  // PostgreSQL schema changes on existing tables require object ownership.
  // The 216-table legacy schema is owned by the existing DBA account; a
  // non-owner role cannot ALTER it even when granted ALL table privileges.
  // Use ONLY the established DBA session behind exact two-person signatures;
  // never provision a new broadly privileged migration login.
  if(row.session_user!=='hi5central'||row.current_user!=='hi5central'
    ||row.rolsuper!==true||row.rolcanlogin!==true)
   throw Error('Scoped schema APPLY requires established DBA owner identity and independent signed review.')
  // The reviewed stamp binds this one transaction to an *exact* starting
  // schema, source SHA, backup, stage and two independent trust anchors.
  // The regular migration runner is never called and its ledger stays zero.
  for(const file of sources)await db.query(file.sql)
  await db.query(
   "CREATE TABLE public.platform_reviewed_baseline_migration_receipts ("+
   "receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"+
   "database_name text NOT NULL,stage text NOT NULL,"+
   "attestation_sha256 text NOT NULL UNIQUE,starting_schema_sha256 text NOT NULL,"+
   "source_commit text NOT NULL,backup_sha256 text NOT NULL,"+
   "reviewer_user_id uuid NOT NULL,dba_reviewer_user_id uuid NOT NULL,"+
   "reviewer_key_sha256 text NOT NULL,dba_key_sha256 text NOT NULL,"+
   "actual_migrations jsonb NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())"
  )
  await db.query(
   'INSERT INTO public.platform_reviewed_baseline_migration_receipts ('+
    'database_name,stage,attestation_sha256,starting_schema_sha256,'+
    'source_commit,backup_sha256,reviewer_user_id,dba_reviewer_user_id,'+
    'reviewer_key_sha256,dba_key_sha256,actual_migrations) '+
    'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',
   [row.database,approval.stage,approval.attestationSha256,schema.fingerprint,
    commit,approval.backupSha256,approval.reviewerId,approval.dbaReviewerId,
    approval.reviewerKeyFingerprint,approval.dbaKeyFingerprint,
    JSON.stringify(sources.map(x=>({name:x.name,sha256:x.sha256})))]
  )
  const safety=await db.query([
   "SELECT (SELECT count(*)::int FROM public.schema_migrations) AS historical_rows,",
   "(SELECT count(*)::int FROM public.platform_release_customer_rollback_executor_certifications) AS seeded_reviews,",
   "(SELECT count(*)::int FROM public.tenant_release_customer_rollback_requests) AS customer_requests,",
   "(SELECT rolcanlogin FROM pg_roles WHERE rolname='hi5_release_rollback_executor') AS worker_can_login,",
   "(SELECT count(*)::int FROM public.platform_reviewed_baseline_migration_receipts) AS receipts",
  ].join(' '))
  const confirmed=safety.rows[0]
  if(confirmed.historical_rows!==0||confirmed.seeded_reviews!==0
    ||confirmed.customer_requests!==0||confirmed.worker_can_login!==false||confirmed.receipts!==1)
   throw Error('Postmigration deny-by-default invariant failed; no SQL committed.')
  await db.query('COMMIT');transaction=false
  console.log(JSON.stringify({result:'EXACT_REVIEWED_MIGRATIONS_APPLIED',database:row.database,
   stage:approval.stage,attestationSha256:approval.attestationSha256,
   historicalLedgerRows:0,workerEnabled:false,customerRequestCreated:false},null,2))
 }catch(error){
  if(transaction)await db.query('ROLLBACK').catch(()=>{})
  throw error
 }finally{await db.end().catch(()=>{})}
}
perform().catch(error=>{
 console.error('REVIEWED_BASELINE_MIGRATION_DENIED',String(error?.message||error).slice(0,750))
 process.exitCode=1
})
