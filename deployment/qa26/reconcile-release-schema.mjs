#!/usr/bin/env node
/**
 * One explicitly audited migration reconciliation for an already-running
 * release QA VPS. NEVER replays migrations 158/159/161/163/164/165 over
 * existing customer objects. Missing objects are applied atomically.
 *
 * Usage: node deployment/qa26/reconcile-release-schema.mjs --dry-run
 *        node deployment/qa26/reconcile-release-schema.mjs --apply
 * Requires a pre-existing, separately verified full database backup, exact
 * intentionally configured target container and paused global rollout.
 *
 * This writes only the ten known migrations and their 16 recorded identities,
 * never tenant rows, routing data, release approvals, Docker or Caddy.
 */
import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)))
const mode=process.argv[2]
if(!['--dry-run','--apply'].includes(mode)||process.argv.length!==3)
 throw Error('Usage: reconcile-release-schema.mjs --dry-run|--apply')
const target=process.env.H5C_RECONCILE_DB_CONTAINER||'h5c-release-schema-reconcile-79'
if(!/^[a-z0-9][a-z0-9-]{4,80}$/.test(target))
 throw Error('An exact, restricted database container name is required.')
const live=target==='hi5central-postgres'
if(live&&mode==='--apply'){
 if(process.env.H5C_RECONCILE_APPROVED!=='schema-only-backup-verified-and-pause-confirmed')
  throw Error('Live reconciliation requires explicit backup and pause authorisation.')
 if(!/^[a-z0-9][a-z0-9-]{8,90}$/.test(process.env.H5C_RECONCILE_BACKUP_ID||''))
  throw Error('Live reconciliation requires a verified off-database backup identifier.')
}
if(!live&&mode==='--apply')
 throw Error('Disposable databases are dry-run only; apply is reserved for reviewed Live.')
const applied=['155','156','157','160','166','167','168','169','170','171']
const existing=['158','159','161','163','164','165']
const expected=[...applied,...existing].sort()
const files=new Map([
 ['155','platform-admin'],['156','itsm'],['157','itsm'],
 ['158','platform-admin'],['159','platform-admin'],['160','platform-admin'],
 ['161','platform-admin'],['163','platform-admin'],['164','platform-admin'],
 ['165','platform-admin'],['166','platform-admin'],['167','platform-admin'],
 ['168','platform-admin'],['169','platform-admin'],['170','platform-admin'],
 ['171','platform-admin'],
])
const names={
 '155':'155_app_release_executor_heartbeat.sql',
 '156':'156_itsm_configuration_audit_value_summaries.sql',
 '157':'157_itsm_configuration_promotions.sql',
 '158':'158_tenant_release_rollout_jobs.sql',
 '159':'159_platform_release_test_qa_gates.sql',
 '160':'160_tenant_test_runtime_assignments.sql',
 '161':'161_release_rollout_blackouts.sql',
 '163':'163_certified_release_fanout.sql',
 '164':'164_automatic_verified_test_canaries.sql',
 '165':'165_single_paused_test_canary.sql',
 '166':'166_generic_release_stage_approvals.sql',
 '167':'167_release_emergency_pause_least_privilege.sql',
 '168':'168_verified_test_canary_gate_least_privilege.sql',
 '169':'169_generic_release_tenant_scope.sql',
 '170':'170_customer_scoped_itsm_rollback.sql',
 '171':'171_customer_release_preparation_drafts.sql',
}
const list=ids=>ids.map(id=>"'"+names[id]+"'").join(',')
const sqls=applied.map(id=>{
 const path=join(root,'services/api/migrations',files.get(id),names[id])
 const text=readFileSync(path,'utf8')
 if(text.length<100||text.length>250000)
  throw Error('Reviewed migration body missing or unexpectedly large: '+id)
 return '\n-- REVIEWED MIGRATION '+id+'\n'+text+'\n'
})
const absent=['platform_application_release_executor_heartbeats',
 'itsm_configuration_promotions','platform_release_generic_stage_approvals',
 'platform_release_emergency_pause_events','platform_release_generic_scope_control',
 'tenant_release_customer_rollback_requests','platform_release_preparation_drafts']
const present=['tenant_release_rollout_jobs','tenant_release_rollout_events',
 'platform_release_rollout_control','platform_release_test_qa_gates',
 'platform_certified_application_releases','platform_release_fanout_checkpoints',
 'platform_release_fanout_events','platform_release_canary_tenants',
 'platform_release_single_test_canary_permits','tenant_runtime_assignments']
const verifiedTables=names=>names.map(n=>"'public."+n+"'").join(',')
const check=`
DO $h5pre$
BEGIN
 IF (SELECT paused IS DISTINCT FROM true FROM public.platform_release_rollout_control
    WHERE singleton=true) IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'H5C reconciliation denied: fleet must be globally paused';
 END IF;
 IF EXISTS (SELECT 1 FROM public.tenant_release_rollout_jobs WHERE status='running')
  THEN RAISE EXCEPTION 'H5C reconciliation denied: active cutover'; END IF;
 IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version IN (${list(expected)}))
  THEN RAISE EXCEPTION 'H5C reconciliation denied: unexpected migration history'; END IF;
 IF EXISTS (SELECT 1 FROM unnest(ARRAY[${verifiedTables(absent)}]::text[]) AS t(name)
     WHERE to_regclass(t.name) IS NOT NULL)
  THEN RAISE EXCEPTION 'H5C reconciliation denied: expected missing objects already exist'; END IF;
 IF EXISTS (SELECT 1 FROM unnest(ARRAY[${verifiedTables(present)}]::text[]) AS t(name)
     WHERE to_regclass(t.name) IS NULL)
  THEN RAISE EXCEPTION 'H5C reconciliation denied: preexisting release control tables missing'; END IF;
END $h5pre$;
`
const final=`
DO $h5post$
BEGIN
 IF (SELECT paused IS DISTINCT FROM true FROM public.platform_release_rollout_control
     WHERE singleton=true) IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'Rollout emergency hold changed during schema reconciliation'; END IF;
 IF EXISTS (SELECT 1 FROM public.tenant_release_rollout_jobs WHERE status='running')
  THEN RAISE EXCEPTION 'A cutover started while migrating'; END IF;
 IF EXISTS (SELECT 1 FROM unnest(ARRAY[${verifiedTables([...absent,...present])}]::text[]) AS t(name)
    WHERE to_regclass(t.name) IS NULL)
  THEN RAISE EXCEPTION 'Expected release table missing after migration'; END IF;
END $h5post$;
INSERT INTO public.schema_migrations(version)
VALUES ${expected.map(id=>"('"+names[id]+"')").join(',')};
`
const body=['BEGIN;',"SET LOCAL lock_timeout='800ms';",
 "SET LOCAL statement_timeout='30s';",
 "SET LOCAL idle_in_transaction_session_timeout='120s';",
 check,...sqls,final,
 mode==='--dry-run'?'ROLLBACK;':'COMMIT;',
 ].join('\n')
const result=await new Promise((resolve,reject)=>{
 const process=spawn('docker',['exec','-i',target,'sh','-c',
  'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-hi5_reconcile_ci}" -X -v ON_ERROR_STOP=1 -q'],
 {stdio:['pipe','pipe','pipe']})
 let stdout='',stderr='',settled=false
 const timer=setTimeout(()=>{process.kill('SIGKILL');if(!settled){settled=true;reject(Error('Reconciliation exceeded bounded time limit.'))}},180000)
 process.stdout.on('data',x=>{stdout+=x;if(stdout.length>80000)process.kill('SIGKILL')})
 process.stderr.on('data',x=>{stderr+=x;if(stderr.length>20000)process.kill('SIGKILL')})
 process.on('error',e=>{clearTimeout(timer);if(!settled){settled=true;reject(e)}})
 process.on('close',code=>{
  clearTimeout(timer)
  if(settled)return;settled=true
  if(code!==0)return reject(Error('Migration transaction refused: '+stderr.slice(-1100)))
  resolve({stdoutBytes:stdout.length})
 })
 process.stdin.end(body)
})
console.log(JSON.stringify({
 type:'H5C_RELEASE_SCHEMA_RECONCILIATION',
 mode,backupId:live?process.env.H5C_RECONCILE_BACKUP_ID:null,
 target:live?'live':'disposable',success:true,
 ddlMigrationsApplied:mode==='--apply'?applied.length:0,
 historicalMigrationsReconciled:mode==='--apply'?existing.length:0,
 transactionCommitted:mode==='--apply',
 hostRoutesChanged:false,pausedFleetRequired:true,
}))
