#!/usr/bin/env node
/**
 * First Platform Admin Owner bootstrap for a clean PostgreSQL reinstall.
 * Reuses an existing verified customer owner/admin identity with enrolled MFA.
 * Root-only operator execution, exact email selection, no passwords in argv,
 * single-transaction privilege grant with PostgreSQL admin audit event.
 * Refuses after the first platform administrator is registered.
 */
import {readFileSync} from 'node:fs'
import {createInterface} from 'node:readline/promises'
import {stdin,stdout,stderr} from 'node:process'
import pg from 'pg'

function refuse(msg){throw new Error(msg)}
if(process.getuid?.()!==0)refuse('Run this bootstrap as root over VPS SSH.')
if(!stdin.isTTY||!stdout.isTTY)refuse('Run interactively in a VPS SSH terminal.')
const raw=readFileSync('/opt/hi5central/runtime/.env','utf8')
const values=Object.fromEntries(raw.split(/\r?\n/)
  .filter(line=>/^[A-Z_]+=.*/.test(line))
  .map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)]}))
if(values.POSTGRES_DB!=='hi5central'||values.POSTGRES_USER!=='hi5central'
  ||typeof values.POSTGRES_PASSWORD!=='string'||values.POSTGRES_PASSWORD.length<24)
  refuse('Expected fresh Hi5Central PostgreSQL credentials missing.')
const db=new pg.Client({host:'127.0.0.1',port:15432,
  database:'hi5central',user:'hi5central',password:values.POSTGRES_PASSWORD,
  connectionTimeoutMillis:8000,application_name:'h5c_first_platform_owner_bootstrap'})
const io=createInterface({input:stdin,output:stdout})
let tx=false
try {
  console.log('Hi5Central — initial Platform Owner')
  console.log('Only an existing verified user who is an active tenant owner/admin with MFA may be added.')
  const email=(await io.question('Enter that account email address: ')).trim().toLowerCase()
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)
    refuse('Invalid email address.')
  await db.connect()
  const identify=await db.query('SELECT current_database() AS db,session_user AS login')
  if(identify.rows[0]?.db!=='hi5central'||identify.rows[0]?.login!=='hi5central')
    refuse('Wrong database or credentials; no change was made.')
  const account=await db.query(
    'SELECT id,email,email_verified_at FROM users WHERE lower(email)=lower($1)',[email])
  if(account.rowCount!==1||!account.rows[0].email_verified_at)
    refuse('No single verified account matches that email. Verify signup first.')
  const id=account.rows[0].id
  const membership=await db.query(
    `SELECT 1 FROM tenant_memberships m
       JOIN tenants t ON t.id=m.tenant_id
       JOIN tenant_settings s ON s.tenant_id=t.id
       WHERE m.user_id=$1 AND m.status='active'
         AND m.role IN ('owner','admin') AND t.status='active'
         AND s.onboarding_completed_at IS NOT NULL LIMIT 1`,[id])
  if(membership.rowCount!==1)
    refuse('Account needs active, onboarded tenant owner/admin membership.')
  const mfa=await db.query(
    `SELECT 1 FROM user_mfa_methods WHERE user_id=$1
       AND method='totp' AND enabled=true AND verified_at IS NOT NULL LIMIT 1`,[id])
  if(mfa.rowCount!==1)refuse(
    'MFA NOT ENROLLED. Sign in to your ITSM workspace, open Profile > Security, enable an authenticator, then run this script again.')
  const present=await db.query('SELECT count(*)::int AS total FROM platform_admin_members')
  if(present.rows[0].total!==0)
    refuse('Platform Admin already exists. Manage additional staff from Admin Centre; bootstrap is one-time only.')
  console.log('Found an eligible verified tenant administrator with MFA enabled.')
  console.log('This will grant Platform OWNER privileges across all Hi5Central tenants.')
  const confirmation=(await io.question('To approve, type GRANT_FIRST_PLATFORM_OWNER: ')).trim()
  if(confirmation!=='GRANT_FIRST_PLATFORM_OWNER')refuse('Cancelled. No changes made.')

  await db.query('BEGIN')
  tx=true
  await db.query("SELECT pg_advisory_xact_lock(hashtext('h5c_first_platform_owner_bootstrap'))")
  const checks=await db.query(
    `SELECT u.id FROM users u
       JOIN tenant_memberships m ON m.user_id=u.id
       JOIN tenants t ON t.id=m.tenant_id
       JOIN tenant_settings s ON s.tenant_id=t.id
       WHERE u.id=$1 AND lower(u.email)=lower($2)
         AND u.email_verified_at IS NOT NULL
         AND m.status='active' AND m.role IN ('owner','admin')
         AND t.status='active' AND s.onboarding_completed_at IS NOT NULL
         AND EXISTS(SELECT 1 FROM user_mfa_methods f
          WHERE f.user_id=u.id AND f.method='totp' AND f.enabled=true
            AND f.verified_at IS NOT NULL)
       LIMIT 1`,[id,email])
  if(checks.rowCount!==1)refuse('Account security changed; nothing was granted.')
  const existing=await db.query('SELECT count(*)::int AS count FROM platform_admin_members')
  if(existing.rows[0].count!==0)refuse('An administrator was already provisioned. Nothing changed.')
  const granted=await db.query(
    `INSERT INTO platform_admin_members(user_id,role,status)
       VALUES($1,'owner','active')
       RETURNING user_id,role,status`,[id])
  await db.query(
    `INSERT INTO platform_admin_audit_events
       (actor_user_id,action,target_type,target_id,metadata)
       VALUES(NULL,'platform.owner_initial_vps_bootstrap','user',$1,$2::jsonb)`,
       [id,JSON.stringify({source:'interactive_root_vps_operator',role:'owner',
         existingUser:true,verifiedEmail:true,enabledTotpVerified:true,
         reason:'Restore initial central Platform Admin after clean Ubuntu reinstall'})])
  await db.query('COMMIT')
  tx=false
  console.log('SUCCESS: Platform Owner granted to your existing verified, MFA-enrolled account.')
  console.log('An auditable privilege-grant record was saved. No user/password was created.')
  console.log('Open https://admin.hi5central.com and sign in with your existing account.')
} catch(e){
  if(tx)await db.query('ROLLBACK').catch(()=>{})
  console.error('STOPPED: '+e.message)
  process.exitCode=1
} finally {
  io.close()
  await db.end().catch(()=>{})
}
