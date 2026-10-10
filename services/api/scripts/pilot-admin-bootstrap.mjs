// Explicit offline first-pilot-Admin issuer. Does not create a password,
// account or session, and NEVER displays tokens or SMTP credentials.
// Requires independently signed operator/reviewer assertions before mutation.
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {readOperatorTrustFile} from '../src/managedOperatorEvidence.js'
import {
  pilotBootstrapEnabled,validatePilotAdminIdentity,verifyPilotBootstrapPair,
  bootstrapToken,bootstrapHash,
} from '../src/pilotAdminBootstrap.js'
import {sendPilotAdminBootstrapInvitationEmail} from '../src/mailer.js'

function required(name){
  const value=String(process.env[name]||'').trim()
  if(!value)throw new Error(name+' is required.')
  return value
}
const mode=process.argv[2]
if(process.argv.length!==3||!['--check','--issue'].includes(mode)){
  console.error('Usage: node pilot-admin-bootstrap.mjs --check|--issue')
  process.exit(2)
}
const client=new pg.Client({connectionString:process.env.PILOT_CONTROL_DATABASE_URL,
  connectionTimeoutMillis:5000,application_name:'hi5-pilot-first-admin-'+randomUUID().slice(0,8)})
let connected=false,inTransaction=false
try{
  if(!pilotBootstrapEnabled(process.env))
    throw new Error('Private managed pilot bootstrap requires exact MFA, API, Admin and deployment scope.')
  if(!process.env.PILOT_CONTROL_DATABASE_URL)throw new Error('Separate pilot DB URL required.')
  const email=mode==='--check' ? String(process.env.INITIAL_ADMIN_EMAIL||'').trim().toLowerCase() : required('INITIAL_ADMIN_EMAIL').toLowerCase()
  const displayName=mode==='--check' ? String(process.env.INITIAL_ADMIN_NAME||'').trim() : required('INITIAL_ADMIN_NAME')
  if((mode==='--issue'||email||displayName) && !validatePilotAdminIdentity({email,displayName}))
    throw new Error('A valid first-administrator name and verified email are required.')
  await client.connect();connected=true
  await client.query('BEGIN');inTransaction=true
  const identity=(await client.query(`
    SELECT current_database() AS db_name,
           current_user AS db_user,
           (SELECT count(*)::int FROM users) AS users_count,
           (SELECT count(*)::int FROM tenants) AS tenants_count,
           (SELECT count(*)::int FROM platform_admin_members) AS admin_count`)).rows[0]
  if(identity.db_name!=='hi5pilotcontrol'||identity.db_user!=='pilot_user_a')
    throw new Error('This is not the approved dedicated pilot control database.')
  if(identity.users_count!==0||identity.tenants_count!==0||identity.admin_count!==0)
    throw new Error('Initial bootstrap requires zero users, tenants and admins.')
  const scoped=(await client.query(`
    SELECT scope_id FROM pilot_admin_bootstrap_scope
    WHERE singleton=true FOR UPDATE`)).rows[0]
  if(!scoped)throw new Error('Pilot bootstrap scope migration is missing.')
  const scopeId=scoped.scope_id
  const control=(await client.query(`
    SELECT instance_id,verified_by FROM managed_control_plane_identity
    WHERE singleton=true`)).rows[0]
  if(control && control.instance_id!==scopeId)
    throw new Error('Existing control plane identity differs from the signed pilot scope.')
  const invitations=await client.query(`
    SELECT id,expires_at,revoked_at,accepted_at,email
      FROM pilot_admin_bootstrap_invitations
      WHERE scope_id=$1 ORDER BY issued_at DESC FOR UPDATE`,[scopeId])
  const active=invitations.rows.find(row=>!row.revoked_at&&!row.accepted_at
    &&new Date(row.expires_at).getTime()>Date.now())
  if(mode==='--check'){
    await client.query('ROLLBACK');inTransaction=false
    console.log(JSON.stringify({mode:'check',scopeId,email,displayName,
      controlAttested:Boolean(control),activeInvitation:Boolean(active),
      users:0,tenants:0,admins:0,publicRouteApproved:false,
      bootstrapAuthorized:false},null,2))
  }else{
    if(active)throw new Error('An unexpired owner invitation already exists; never replace it.')
    const actorToken=required('PILOT_ADMIN_ACTOR_ASSERTION')
    const reviewerToken=required('PILOT_ADMIN_REVIEWER_ASSERTION')
    const trust=readOperatorTrustFile(required('PILOT_OPERATOR_TRUST_FILE'))
    const approvals=verifyPilotBootstrapPair(actorToken,reviewerToken,trust,
      {scopeId,email,displayName})
    if(required('CONFIRM_PILOT_ADMIN_BOOTSTRAP')
      !==`${scopeId}:${email}:invite`)
      throw new Error('Confirmation must match signed scope UUID:email:invite.')
    if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASSWORD)
      throw new Error('Approved, separately scoped pilot SMTP relay must be configured.')
    if(!control) {
      await client.query(`INSERT INTO managed_control_plane_identity
         (singleton,deployment_mode,tenancy_mode,root_domain,instance_id,verified_by)
         VALUES(true,'managed','multi','hi5central.com',$1,$2)`,
        [scopeId,`${approvals.actor.operatorId}/${approvals.reviewer.operatorId}`])
    }
    for(const old of invitations.rows) {
      if(!old.accepted_at&&!old.revoked_at) {
        await client.query(`
          UPDATE pilot_admin_bootstrap_invitations
          SET revoked_at=now() WHERE id=$1`,[old.id])
        await client.query(`
          INSERT INTO pilot_admin_bootstrap_audit
            (scope_id,invitation_id,action,operator_id)
          VALUES($1,$2,'cancelled',$3)`,[scopeId,old.id,approvals.actor.operatorId])
      }
    }
    const token=bootstrapToken()
    const insert=(await client.query(`
      INSERT INTO pilot_admin_bootstrap_invitations
       (scope_id,email,display_name,token_hash,issued_by,reviewed_by,
        actor_evidence_sha256,reviewer_evidence_sha256,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '24 hours')
      RETURNING id`,[scopeId,email,displayName,bootstrapHash(token),
        approvals.actor.operatorId,approvals.reviewer.operatorId,
        approvals.actor.sha256,approvals.reviewer.sha256])).rows[0]
    await client.query(`
      INSERT INTO pilot_admin_bootstrap_audit
       (scope_id,invitation_id,action,operator_id)
      VALUES($1,$2,'issued',$3)`,[scopeId,insert.id,approvals.actor.operatorId])
    await client.query('COMMIT');inTransaction=false
    try{
      await sendPilotAdminBootstrapInvitationEmail({to:email,name:displayName,token})
    }catch(error){
      await client.query('BEGIN');inTransaction=true
      await client.query(`UPDATE pilot_admin_bootstrap_invitations
        SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL`,[insert.id])
      await client.query(`
        INSERT INTO pilot_admin_bootstrap_audit
         (scope_id,invitation_id,action,operator_id)
        VALUES($1,$2,'delivery_failed',$3)`,
        [scopeId,insert.id,approvals.actor.operatorId])
      await client.query('COMMIT');inTransaction=false
      throw new Error('Invitation delivery failed and token was revoked; check the scoped mail relay.')
    }
    console.log(JSON.stringify({mode:'issued',scopeId,invitationId:insert.id,
      email,expiresInHours:24,delivery:'accepted_by_smtp_relay',
      tokenPrinted:false,accountCreated:false,publicRouteApproved:false},null,2))
  }
}catch(error){
  if(inTransaction)await client.query('ROLLBACK').catch(()=>{})
  console.error('Pilot Admin bootstrap denied:',error.message)
  process.exitCode=1
}finally{if(connected)await client.end().catch(()=>{})}
