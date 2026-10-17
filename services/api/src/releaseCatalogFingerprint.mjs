#!/usr/bin/env node
/**
 * Canonical structural fingerprints for reviewed release schema objects.
 * PostgreSQL 17; ALWAYS BEGIN READ ONLY and ROLLBACK.
 * Compares structural identity only: owner, ACL, data, row policies, actual
 * trigger execution and migration-ledger history must be separately reviewed.
 * Never apply migrations or alter any object here.
 */
import {createHash} from 'node:crypto'
import pg from 'pg'

const relationGroups={
 '158':['tenant_release_rollout_jobs','tenant_release_rollout_events','platform_release_rollout_control'],
 '159':['platform_release_test_qa_gates'],
 '161':['tenant_release_preferences','tenant_release_rollout_jobs'],
 '163':['platform_certified_application_releases','platform_release_fanout_checkpoints','platform_release_fanout_events'],
 '164':['platform_release_canary_tenants','platform_release_test_qa_gates'],
 '165':['platform_release_single_test_canary_permits'],
 '160':['tenant_runtime_assignments','tenant_runtime_update_offers',
        'tenant_runtime_route_attestations','platform_runtime_route_generations'],
 '155':['platform_application_release_executor_heartbeats'],
 '156':['itsm_configuration_change_events'],
 '157':['itsm_configuration_promotions'],
 '166':['platform_release_generic_stage_approvals','platform_release_generic_approval_audit'],
 '167':['platform_release_emergency_pause_events'],
}
if(process.argv.length!==2)throw Error('No arguments: read-only structural fingerprint only')
if(!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL||''))
 throw Error('DATABASE_URL must be supplied securely')
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
 connectionTimeoutMillis:7000})
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const rows=async (sql,params=[]) => (await db.query(sql,params)).rows
try{
 await db.connect()
 await db.query('BEGIN READ ONLY')
 await db.query("SET LOCAL statement_timeout='15000ms'")
 const details={}
 for(const name of new Set(Object.values(relationGroups).flat()).values()){
  const found=await rows("SELECT to_regclass($1) IS NOT NULL AS present",['public.'+name])
  if(!found[0]?.present){details[name]=null;continue}
  const cols=await rows([
    'SELECT a.attname name,format_type(a.atttypid,a.atttypmod) type,',
    'a.attnotnull required,a.attidentity identity,',
    'pg_get_expr(d.adbin,d.adrelid) default_value',
    'FROM pg_attribute a LEFT JOIN pg_attrdef d',
    'ON d.adrelid=a.attrelid AND d.adnum=a.attnum',
    "WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped",
    'ORDER BY a.attnum',
  ].join(' '),['public.'+name])
  const cons=await rows([
    'SELECT conname name,contype type,convalidated validated,',
    'pg_get_constraintdef(oid) definition',
    'FROM pg_constraint WHERE conrelid=to_regclass($1) ORDER BY conname',
  ].join(' '),['public.'+name])
  const index=await rows([
    'SELECT indexname name,indexdef definition FROM pg_indexes',
    "WHERE schemaname='public' AND tablename=$1 ORDER BY indexname",
  ].join(' '),[name])
  const triggers=await rows([
    'SELECT tgname name,tgenabled enabled,pg_get_triggerdef(oid) definition',
    'FROM pg_trigger WHERE tgrelid=to_regclass($1)',
    'AND NOT tgisinternal ORDER BY tgname',
  ].join(' '),['public.'+name])
  details[name]=hash({columns:cols,constraints:cons,indexes:index,triggers})
 }
 const report={audit:'H5C_RELEASE_CANONICAL_STRUCTURAL_SHA256_V1',
  readOnly:true,createdAt:new Date().toISOString(),
  warning:'Hashes represent structural metadata only; no ACL, ownership, data or policy equivalence is claimed.',
  relationSha256:details,
  groupSha256:Object.fromEntries(Object.entries(relationGroups).map(
    ([id,names])=>[id,names.every(n=>details[n])
       ?hash(names.map(n=>[n,details[n]])):null]))}
 console.log('H5C_CANONICAL_CATALOG_START')
 console.log(JSON.stringify(report))
 console.log('H5C_CANONICAL_CATALOG_END')
 await db.query('ROLLBACK')
}finally{await db.end()}
