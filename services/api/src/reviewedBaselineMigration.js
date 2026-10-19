import {createHash,createPublicKey,verify} from 'node:crypto'

/**
 * This is structural attestation, not historical migration provenance.
 * Only an independently signed, database-specific snapshot may advance into
 * separately receipted migrations. No schema_migrations row is backfilled.
 */
export const TARGETS=Object.freeze({
  live:'hi5central',dev:'hi5central_dev',
  test:'hi5central_test',uat:'hi5central_uat',
})
export const ROLLBACK_SQL=Object.freeze([
  '178_independent_customer_rollback_executor_certification.sql',
  '179_restricted_customer_rollback_worker_claim.sql',
  '180_restricted_customer_rollback_completion.sql',
])
export const RECEIPT_TABLE='platform_reviewed_baseline_migration_receipts'
const HEX64=/^[a-f0-9]{64}$/
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const fail=(message)=>{throw Error('BASELINE_APPROVAL_DENIED: '+message)}
export const sha256=input=>createHash('sha256').update(input).digest('hex')
export function canonicalJson(value){
  if(value===null||typeof value==='string'||typeof value==='boolean'
    ||typeof value==='number'&&Number.isSafeInteger(value))
    return JSON.stringify(value)
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']'
  if(value&&typeof value==='object'){
    const keys=Object.keys(value).sort()
    if(keys.some(k=>k==='__proto__'||k==='constructor'||k==='prototype'))
      fail('Invalid manifest property.')
    return '{'+keys.map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}'
  }
  fail('Invalid manifest value type.')
}
export const SCHEMA_QUERIES=Object.freeze({
  tables: "SELECT tablename,tableowner,hasindexes,hastriggers,rowsecurity FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  columns: "SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
  indexes: "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
  constraints: "SELECT c.conrelid::regclass::text AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY table_name,c.conname",
  functions: "SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition,p.prosecdef,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,arguments",
  triggers: "SELECT t.tgrelid::regclass::text AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY table_name,t.tgname",
  policies: "SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname",
  relationsAcl: "SELECT c.relname,c.relkind,c.relacl::text AS acl,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') ORDER BY c.relname",
  roles: "SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname LIKE 'hi5_%' ORDER BY rolname",
})
export async function captureSchemaFingerprint(db){
 const inventory={}
 // Stable ordering and column names are intentional. No customer row data.
 for(const [name,query] of Object.entries(SCHEMA_QUERIES)){
   const response=await db.query(query)
   inventory[name]=response.rows
 }
 const tableCount=inventory.tables.length
 return {fingerprint:sha256(canonicalJson(inventory)),tableCount,
   relationCount:inventory.relationsAcl.length,functionCount:inventory.functions.length,
   policyCount:inventory.policies.length,inventory}
}
export function validateSignedBaseline({
  envelope,reviewerPublicKey,dbaPublicKey,
  now=new Date(),database,baselineFingerprint,publicTableCount,
  workerRevisionSha,migrationHashes,sourceCommit,
}){
 if(!envelope||Object.keys(envelope).sort().join(',')!=='dbaSignature,payload,reviewerSignature')
   fail('Exactly two signatures and a signed payload are mandatory.')
 const p=envelope.payload
 if(!p||p.version!==1||p.purpose!=='custom-customer-rollback-178-180'
   ||!Object.hasOwn(TARGETS,p.stage)||TARGETS[p.stage]!==database
   ||p.database!==database||!HEX64.test(String(p.schemaFingerprint||''))
   ||p.schemaFingerprint!==baselineFingerprint
   ||p.publicTableCount!==publicTableCount||p.previousLedgerRows!==0
   ||!SHA.test(String(p.sourceCommit||''))||p.sourceCommit!==sourceCommit
   ||!SHA.test(String(p.workerRevisionSha||''))||p.workerRevisionSha!==workerRevisionSha
   ||!HEX64.test(String(p.backupSha256||''))
   ||typeof p.backupPath!=='string'
   ||!p.backupPath.startsWith('/opt/hi5central/recovery/')
   ||p.backupPath.includes('..')
   ||p.backupRestored!==true
   ||p.schemaEquivalenceReviewed!==true||p.stageIsolationReviewed!==true
   ||p.historyUnverifiedAcknowledged!==true
   ||p.customerRoutesMustRemainUnchanged!==true
   ||p.rollbackWorkerMustRemainDisabled!==true
   ||!UUID.test(String(p.reviewerId||''))
   ||!UUID.test(String(p.dbaReviewerId||''))
   ||p.reviewerId===p.dbaReviewerId
   ||typeof p.reason!=='string'||p.reason.trim().length<35
   ||p.reason.length>1000
   ||!Array.isArray(p.migrations)||p.migrations.length!==ROLLBACK_SQL.length)
   fail('Stage, schema, SQL scope, independent reviewers or recovery evidence differs.')
 for(let i=0;i<ROLLBACK_SQL.length;i++){
   if(p.migrations[i]?.name!==ROLLBACK_SQL[i]
    ||p.migrations[i]?.sha256!==migrationHashes[i]
    ||!HEX64.test(String(p.migrations[i]?.sha256||'')))
    fail('Only the reviewed SQL migrations 178–180 may execute.')
 }
 const issued=Date.parse(p.reviewedAt),expiry=Date.parse(p.expiresAt)
 const nowMs=now.getTime()
 if(!Number.isFinite(issued)||!Number.isFinite(expiry)
  ||issued>nowMs||expiry<=nowMs||expiry<=issued
  ||expiry-issued>4*60*60*1000)
   fail('Two-person review is expired, premature or longer than four hours.')
 let reviewer,dba
 try{
   reviewer=reviewerPublicKey?.type==='public' ? reviewerPublicKey : createPublicKey(reviewerPublicKey)
   dba=dbaPublicKey?.type==='public' ? dbaPublicKey : createPublicKey(dbaPublicKey)
 }catch{fail('Trust anchors were not provisioned by platform security.')}
 if(reviewer.asymmetricKeyType!=='ed25519'||dba.asymmetricKeyType!=='ed25519'
   ||reviewer.export({format:'der',type:'spki'}).equals(dba.export({format:'der',type:'spki'})))
   fail('Two separate Ed25519 trust anchors required.')
 const message=Buffer.from(canonicalJson(p),'utf8')
 const decode=signature=>{
   if(typeof signature!=='string'||!/^[a-zA-Z0-9+/]{86}==$/.test(signature))
     fail('Malformed reviewer signature.')
   return Buffer.from(signature,'base64')
 }
 if(!verify(null,message,reviewer,decode(envelope.reviewerSignature))
   ||!verify(null,message,dba,decode(envelope.dbaSignature)))
   fail('Independent signatures do not authenticate this exact baseline.')
 return {
   attestationSha256:sha256(canonicalJson(envelope)),
   reviewerKeyFingerprint:sha256(reviewer.export({format:'der',type:'spki'})),
   dbaKeyFingerprint:sha256(dba.export({format:'der',type:'spki'})),
   stage:p.stage,database:p.database,sourceCommit:p.sourceCommit,
   backupPath:p.backupPath,backupSha256:p.backupSha256,
   reviewerId:p.reviewerId,dbaReviewerId:p.dbaReviewerId,
   migrations:p.migrations,
 }
}
