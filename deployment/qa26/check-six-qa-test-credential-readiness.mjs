#!/usr/bin/env node
/** READ-ONLY QA26 Test credential security readiness. Never prints credentials. */
import {execFileSync} from 'node:child_process'
import {statSync,lstatSync} from 'node:fs'
const fail=reason=>{console.error('QA_SIX_TEST_SECURITY_BLOCKED '+reason);process.exitCode=1}
let role
try{
 const js=String.raw`
const{Client}=require('pg')
;(async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL})
 await c.connect()
 try{
  await c.query('BEGIN READ ONLY')
  const r=(await c.query([
  "WITH role AS (SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit",
  "FROM pg_roles WHERE rolname='hi5_release_qa_canary')",
  "SELECT EXISTS(SELECT 1 FROM role WHERE rolcanlogin AND NOT rolsuper",
  "AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit) AS identity_safe,",
  "COALESCE((SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,role",
  "WHERE c.relkind='S' AND n.nspname='public'",
  "AND has_sequence_privilege(role.oid,c.oid,'USAGE')),0) AS usable_sequence_count,",
  "COALESCE((SELECT has_sequence_privilege(role.oid,",
  "'public.tenant_release_rollout_events_id_seq'::regclass,'USAGE') FROM role),false)",
  "AS event_sequence_allowed,",
  "COALESCE((SELECT has_table_privilege(role.oid,",
  "'platform_release_rollout_control'::regclass,'UPDATE') FROM role),false)",
  "AS can_change_global_pause"
  ].join(' '))).rows[0]
  const state=(await c.query('SELECT paused FROM platform_release_rollout_control WHERE singleton=true')).rows[0]
  console.log(JSON.stringify({role:r,paused:state?.paused}))
  await c.query('ROLLBACK')
 }finally{await c.end()}
})().catch(()=>process.exit(1))
`
 role=JSON.parse(execFileSync('docker',['exec','hi5central-certified-release-planner',
  'node','-e',js],{encoding:'utf8',timeout:25000}))
}catch{fail('Authoritative read-only security query unavailable');process.exit()}
const safe=role.paused===true&&role.role?.identity_safe===true&&
 role.role?.usable_sequence_count===1&&
 role.role?.event_sequence_allowed===true&&
 role.role?.can_change_global_pause===false
let fileSafe=false
try{
 const dir='/etc/hi5central/qa-single-test-canary'
 const path=dir+'/database.url'
 const d=lstatSync(dir),f=lstatSync(path)
 fileSafe=d.isDirectory()&&!d.isSymbolicLink()&&
  d.uid===0&&(d.mode&0o077)===0&&
  f.isFile()&&!f.isSymbolicLink()&&f.uid===0&&(f.mode&0o077)===0
}catch{}
console.log(JSON.stringify({
  scope:'six-QA-Test-only',
  globalPause:role.paused,
  roleIdentitySafe:role.role?.identity_safe,
  publicSequenceGrants:role.role?.usable_sequence_count,
  exactEventSequencePrivilege:role.role?.event_sequence_allowed,
  globalPauseUpdatePrivilege:role.role?.can_change_global_pause,
  hostCredentialPermissionsSafe:fileSafe,
  executionCredentialReady:safe&&fileSafe
}))
if(!safe)fail('Dedicated DB role missing or privileges not yet reviewed')
if(!fileSafe)fail('Dedicated 0400 root-owned host secret has not been provisioned')
