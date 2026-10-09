import { pool, withTransaction } from './db.js'
import { deployment, originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'
import { hashPassword, passwordPolicyResult, verifyPassword } from './password.js'
import { sendManagedSandboxInvitationEmail } from './mailer.js'
import { isManagedCustomerSandbox } from './managedSandboxPolicy.js'
import {
  invitationHash, invitationToken, validInvitationToken, validInvitationEmail,
  permittedInvitationRole, sandboxInvitationGate, validInvitationRecord,
  INVITATION_TTL_HOURS,
} from './managedSandboxInvitations.js'

function sandboxOriginAllowed(c, slug) {
  const origin = String(c.req.header('origin') || '')
  return Boolean(origin && originMatchesTenant(origin, slug))
}

async function invitationEligibility(db, slug) {
  const { rows } = await db.query(
    `SELECT t.id,t.slug,t.company_name,t.status,ts.tenant_url,ts.modules,
            b.local_tenant_id,b.control_request_id,b.environment,b.stage,
            a.tenant_id AS approval_tenant_id,a.bootstrap_request_id,
            a.state AS approval_state,a.approved_by,a.approved_at
       FROM tenants t
       JOIN tenant_settings ts ON ts.tenant_id=t.id
       LEFT JOIN managed_environment_tenant_bootstrap b ON b.local_tenant_id=t.id
       LEFT JOIN managed_environment_access_approvals a ON a.tenant_id=t.id
      WHERE t.slug=$1 LIMIT 1`,
    [slug],
  )
  const row=rows[0]
  if (!row) return null
  const bootstrap=row.local_tenant_id ? {
    local_tenant_id:row.local_tenant_id,
    control_request_id:row.control_request_id,
    environment:row.environment,stage:row.stage,
  } : null
  const approval=row.approval_tenant_id ? {
    tenant_id:row.approval_tenant_id,
    bootstrap_request_id:row.bootstrap_request_id,
    state:row.approval_state,approved_by:row.approved_by,approved_at:row.approved_at,
  } : null
  return { row, decision:sandboxInvitationGate(deployment,row,bootstrap,approval,row.modules) }
}

function unavailable(c) {
  return c.json({ error:'Customer sandbox invitations are unavailable until environment activation is independently approved.',
    code:'SANDBOX_INVITATIONS_LOCKED' },423)
}

export function registerManagedSandboxInvitationRoutes(app) {
  app.post('/api/v1/auth/sandbox-invitations/issue', async (c) => {
    if (!isManagedCustomerSandbox(deployment)) return c.json({ error:'Not found.' },404)
    c.header('Cache-Control','no-store')
    const session=await resolveSession(c)
    if (!session) return c.json({ error:'Authentication required.' },401)
    if (!['owner','admin'].includes(session.tenant_role)) return c.json({ error:'Administrator access required.' },403)
    if (!sandboxOriginAllowed(c,session.slug)) return c.json({ error:'Tenant origin mismatch.' },403)
    const body=await c.req.json().catch(()=>null)
    const email=String(body?.email || '').trim().toLowerCase()
    const name=String(body?.name || '').trim()
    const role=String(body?.role || '').trim().toLowerCase()
    if (!validInvitationEmail(email) || name.length<2 || name.length>120
      || !permittedInvitationRole(role,session.tenant_role)) {
      return c.json({ error:'Provide a valid name, email and permitted role.' },400)
    }
    const invited=await withTransaction(async db=>{
      const approved=await invitationEligibility(db,session.slug)
      if (!approved?.decision.allowed || approved.row.id!==session.tenant_id) {
        return { locked:true }
      }
      const recent=await db.query(
        `SELECT count(*)::int AS count FROM managed_environment_invitations
          WHERE tenant_id=$1 AND created_at > now()-interval '24 hours'`,[session.tenant_id],
      )
      if (Number(recent.rows[0]?.count||0)>=30) return { rateLimited:true }
      // Expired pending records must be explicitly revoked before reissue.
      await db.query(
        `UPDATE managed_environment_invitations SET revoked_at=now()
          WHERE tenant_id=$1 AND email=$2 AND accepted_at IS NULL
            AND revoked_at IS NULL AND expires_at<=now()`,
        [session.tenant_id,email],
      )
      const active=await db.query(
        `SELECT 1 FROM managed_environment_invitations
          WHERE tenant_id=$1 AND email=$2
            AND accepted_at IS NULL AND revoked_at IS NULL LIMIT 1`,
        [session.tenant_id,email],
      )
      if (active.rowCount) return { duplicate:true }
      const member=await db.query(
        `SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id
          WHERE m.tenant_id=$1 AND u.email=$2 LIMIT 1`,[session.tenant_id,email],
      )
      if(member.rowCount) return { duplicate:true }
      const token=invitationToken()
      const issued=await db.query(
        `INSERT INTO managed_environment_invitations
          (tenant_id,email,name,role,token_hash,issued_by_user_id,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,now()+make_interval(hours=>$7::int))
         RETURNING id,expires_at`,
        [session.tenant_id,email,name,role,invitationHash(token),session.user_id,INVITATION_TTL_HOURS],
      )
      return { token, id:issued.rows[0].id,expiresAt:issued.rows[0].expires_at,
        companyName:approved.row.company_name,tenantUrl:approved.row.tenant_url }
    })
    if(invited.locked) return unavailable(c)
    if(invited.rateLimited) return c.json({ error:'Invitation limit reached for this environment.' },429)
    if(invited.duplicate) return c.json({ error:'This user is already a member or has an active invitation.' },409)
    try {
      await sendManagedSandboxInvitationEmail({
        to:email,name,role,token:invited.token,
        companyName:invited.companyName,tenantUrl:invited.tenantUrl,
        environment:deployment.runtimeEnvironment,
      })
    } catch (error) {
      await pool.query(
        `UPDATE managed_environment_invitations
           SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL`,
        [invited.id],
      ).catch(()=>{})
      console.error('Sandbox invitation delivery failed',error.message)
      return c.json({ error:'Could not deliver invitation; no access was granted.' },503)
    }
    return c.json({ status:'invited',expiresAt:invited.expiresAt },201)
  })

  app.post('/api/v1/auth/sandbox-invitations/accept', async (c) => {
    if (!isManagedCustomerSandbox(deployment)) return c.json({ error:'Not found.' },404)
    c.header('Cache-Control','no-store')
    const body=await c.req.json().catch(()=>null)
    const slug=String(body?.tenantSlug||'').trim().toLowerCase()
    const token=body?.token
    const password=String(body?.password||'')
    if(!validInvitationToken(token) || slug.length>48 || !/^[a-z0-9-]+$/.test(slug)) {
      return c.json({ error:'Invitation is invalid or expired.' },400)
    }
    if(!sandboxOriginAllowed(c,slug)) return c.json({ error:'Tenant origin mismatch.' },403)
    const passwordPolicy=passwordPolicyResult(password,'strong')
    if(!passwordPolicy.ok) return c.json({ error:passwordPolicy.message },400)

    const result=await withTransaction(async db=>{
      const eligibility=await invitationEligibility(db,slug)
      if (!eligibility?.decision.allowed) return { locked:true }
      const inv=await db.query(
        `SELECT * FROM managed_environment_invitations
          WHERE token_hash=$1 AND tenant_id=$2 FOR UPDATE`,
        [invitationHash(token),eligibility.row.id],
      )
      const invitation=inv.rows[0]
      if(!validInvitationRecord(invitation,eligibility.row.id,invitation?.email)) return { invalid:true }
      const existing=await db.query('SELECT id,password_hash FROM users WHERE email=$1 FOR UPDATE',[invitation.email])
      let userId
      if(existing.rowCount){
        if(!await verifyPassword(password,existing.rows[0].password_hash)) return { invalidPassword:true }
        userId=existing.rows[0].id
      }else{
        const hashed=await hashPassword(password)
        const newUser=await db.query(
          'INSERT INTO users(email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id',
          [invitation.email,invitation.name,hashed],
        )
        userId=newUser.rows[0].id
      }
      const current=await db.query(
        'SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2',
        [eligibility.row.id,userId],
      )
      if(current.rowCount) return { alreadyMember:true }
      await db.query(
        `INSERT INTO tenant_memberships (tenant_id,user_id,role,status)
          VALUES ($1,$2,$3,'active')`,
        [eligibility.row.id,userId,invitation.role],
      )
      await db.query(
        'UPDATE managed_environment_invitations SET accepted_at=now() WHERE id=$1 AND accepted_at IS NULL',
        [invitation.id],
      )
      return { accepted:true }
    })
    if(result.locked) return unavailable(c)
    if(result.invalid || result.invalidPassword) return c.json({ error:'Invitation is invalid or could not be verified.' },401)
    if(result.alreadyMember) return c.json({ error:'This account is already a tenant member.' },409)
    // No session is created: secure sign-in demands environment-local TOTP MFA.
    return c.json({ accepted:true,signInRequired:true,mfaRequired:true },200)
  })
}
