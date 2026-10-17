#!/usr/bin/env node
/**
 * READ ONLY PostgreSQL 17 migration surface audit.
 *
 * Does NOT reconcile the migration ledger, create roles, change schema,
 * approve releases, or touch Caddy. A passing surface audit is NOT full
 * DDL/ACL/data equivalence; independent review is still mandatory before
 * historical schema_migrations records can be reconciled.
 *
 * Usage: DATABASE_URL=... node src/releaseMigrationReadiness.mjs
 * CI:    DATABASE_URL=... node src/releaseMigrationReadiness.mjs --require-complete
 */
import pg from 'pg'

const expected = [
  {id:'155_app_release_executor_heartbeat.sql',
   tables:['platform_application_release_executor_heartbeats'],
   columns:[['platform_application_release_executor_heartbeats','worker_id'],
            ['platform_application_release_executor_heartbeats','capability']]},
  {id:'156_itsm_configuration_audit_value_summaries.sql',
   columns:[['itsm_configuration_change_events','value_changes']],
   constraints:['itsm_configuration_change_events_values_safe_shape']},
  {id:'157_itsm_configuration_promotions.sql',
   tables:['itsm_configuration_promotions'],
   indexes:['idx_itsm_configuration_promotions_tenant']},
  {id:'158_tenant_release_rollout_jobs.sql',
   tables:['tenant_release_rollout_jobs','tenant_release_rollout_events',
           'platform_release_rollout_control'],
   columns:[['tenant_release_rollout_jobs','lease_token'],
            ['tenant_release_rollout_jobs','lease_fence'],
            ['tenant_release_rollout_jobs','lease_expires_at'],
            ['tenant_release_rollout_events','event_type']],
   indexes:['unique_active_tenant_environment_rollout',
            'due_release_rollout_jobs','tenant_release_rollout_event_timeline',
            'tenant_release_rollout_event_by_job']},
  {id:'159_platform_release_test_qa_gates.sql',
   tables:['platform_release_test_qa_gates'],
   columns:[['platform_release_test_qa_gates','passed_canary_count']]},
  {id:'160_tenant_test_runtime_assignments.sql',
   envConstraints:['tenant_runtime_assignments','tenant_runtime_update_offers',
     'tenant_runtime_route_attestations','platform_runtime_route_generations']},
  {id:'161_release_rollout_blackouts.sql',
   columns:[['tenant_release_preferences','blackout_periods'],
            ['tenant_release_rollout_jobs','expected_duration_minutes']],
   constraints:['tenant_release_preferences_blackout_periods_array',
                'tenant_release_rollout_jobs_expected_duration_minutes_check']},
  {id:'163_certified_release_fanout.sql',
   tables:['platform_certified_application_releases',
           'platform_release_fanout_checkpoints','platform_release_fanout_events'],
   indexes:['certified_application_releases_ready',
            'platform_release_fanout_events_recent']},
  {id:'164_automatic_verified_test_canaries.sql',
   tables:['platform_release_canary_tenants'],
   indexes:['platform_release_canary_tenants_active'],
   automaticQaGate:true},
  {id:'165_single_paused_test_canary.sql',
   tables:['platform_release_single_test_canary_permits'],
   indexes:['single_armed_release_test_canary']},
  {id:'166_generic_release_stage_approvals.sql',
   tables:['platform_release_generic_stage_approvals',
           'platform_release_generic_approval_audit'],
   indexes:['generic_release_approval_audit_recent'],
   triggers:[['platform_release_generic_stage_approvals',
              'generic_release_stage_approval_audit']]},
  {id:'167_release_emergency_pause_least_privilege.sql',
   tables:['platform_release_emergency_pause_events'],
   procedures:['hi5_release_emergency_pause']},
]
const args=process.argv.slice(2)
if(args.some(x=>x!=='--require-complete') || args.length>1)
  throw Error('Usage: node src/releaseMigrationReadiness.mjs [--require-complete]')
if(!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL||''))
  throw Error('DATABASE_URL is required (never print its value)')

const client=new pg.Client({connectionString:process.env.DATABASE_URL,
 connectionTimeoutMillis:7000})
let complete=false
try {
 await client.connect()
 await client.query('BEGIN READ ONLY')
 await client.query("SET LOCAL statement_timeout = '15000ms'")
 const fetch=async (sql,params=[]) => (await client.query(sql,params)).rows
 const rows=await fetch(
   'SELECT version FROM schema_migrations WHERE version=ANY($1::text[])',
   [expected.map(e=>e.id)])
 const ledger=new Set(rows.map(r=>r.version))
 const relations=new Set((await fetch(
   "SELECT tablename FROM pg_tables WHERE schemaname='public'")).map(r=>r.tablename))
 const cols=new Map((await fetch(
   "SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema='public'"
 )).map(r=>[r.table_name+'.'+r.column_name,r]))
 const indexes=new Set((await fetch(
   "SELECT indexname FROM pg_indexes WHERE schemaname='public'")).map(r=>r.indexname))
 const constraints=new Map((await fetch(
   "SELECT co.conname,cl.relname,pg_get_constraintdef(co.oid) AS definition,co.convalidated FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='public'"
 )).map(r=>[r.conname,r]))
 const triggers=new Set((await fetch(
   "SELECT cl.relname||'.'||t.tgname AS name FROM pg_trigger t JOIN pg_class cl ON cl.oid=t.tgrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal"
 )).map(r=>r.name))
 const procedures=new Map((await fetch(
   "SELECT p.proname, p.prosecdef, p.proconfig, EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_can_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='hi5_release_emergency_pause' AND pg_get_function_identity_arguments(p.oid)='p_worker_id text, p_reason text'"
 )).map(r=>[r.proname,r]))
 const checks=[]
 for(const manifest of expected){
  const missing=[]
  for(const t of manifest.tables||[])if(!relations.has(t))
    missing.push('table:'+t)
  for(const [t,col] of manifest.columns||[]){
    const c=cols.get(t+'.'+col)
    if(!c)missing.push('column:'+t+'.'+col)
    else if(t==='itsm_configuration_change_events'&&col==='value_changes'&&c.data_type!=='jsonb')
      missing.push('column_type:'+t+'.'+col)
    else if(t==='tenant_release_rollout_jobs'&&col==='expected_duration_minutes'&&c.data_type!=='integer')
      missing.push('column_type:'+t+'.'+col)
  }
  for(const ix of manifest.indexes||[])if(!indexes.has(ix))
    missing.push('index:'+ix)
  for(const name of manifest.constraints||[])if(!constraints.get(name)?.convalidated)
    missing.push('validated_constraint:'+name)
  for(const [table,name] of manifest.triggers||[])if(!triggers.has(table+'.'+name))
    missing.push('trigger:'+table+'.'+name)
  for(const table of manifest.envConstraints||[]){
    const constraint=constraints.get(table+'_environment_check')
    const found=[...(constraint?.definition||'').matchAll(/'(test|uat|live)'::text/g)].map(x=>x[1]).sort()
    if(!constraint?.convalidated||found.join(',')!=='live,test,uat')
      missing.push('test_environment_check:'+table)
  }
  if(manifest.automaticQaGate){
    const qa=constraints.get('platform_release_test_qa_gates_check')
    if(!qa?.convalidated||!qa.definition.includes('verifiedJobIds')
       ||!qa.definition.includes('accepted_by IS NOT NULL'))
      missing.push('automatic_two_canary_gate')
  }
  for(const name of manifest.procedures||[]){
    const p=procedures.get(name)
    if(!p||!p.prosecdef||p.public_can_execute
       ||!p.proconfig?.some(x=>x.startsWith('search_path=')))
      missing.push('default_denied_secure_function:'+name)
  }
  checks.push({migration:manifest.id,ledgerRecorded:ledger.has(manifest.id),
    surfaceChecksPassed:missing.length===0,missing})
 }
 complete=checks.every(x=>x.ledgerRecorded&&x.surfaceChecksPassed)
 console.log(JSON.stringify({
   audit:'H5C_READ_ONLY_MIGRATION_CATALOG_V1',readOnly:true,
   generatedAt:new Date().toISOString(),complete,
   surfaceChecksPassing:checks.filter(x=>x.surfaceChecksPassed).length,
   ledgerEntriesPresent:checks.filter(x=>x.ledgerRecorded).length,
   checks,
   warning:'Surface presence is NOT full DDL, ACL, ownership, trigger body or data equivalence. Historical ledger repairs require independently reviewed canonical schema diff.',
 },null,2))
 await client.query('ROLLBACK')
}finally{await client.end()}
if(args.includes('--require-complete')&&!complete)process.exitCode=2
