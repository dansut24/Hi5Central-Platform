import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { isValidCustomerSlug } from '../src/tenantEnvironmentHostnames.js'
import { validateRuntimeAttestation } from '../src/managedRuntimeGuard.js'
import {
  invitationHash, invitationToken, validInvitationEmail, sandboxInvitationGate,
  INVITATION_TTL_HOURS,
} from '../src/managedSandboxInvitations.js'
import { sendManagedSandboxInvitationEmail } from '../src/mailer.js'

function required(name) {
  const value=String(process.env[name]||'').trim()
  if(!value) throw new Error(name+' is required.')
  return value
}

async function run() {
  const args=process.argv.slice(2)
  if(args.length>1 || args.some(v=>!['--check','--apply'].includes(v))) {
    throw new Error('Usage: node tenant-environment-owner-invite.mjs [--check|--apply]')
  }
  const apply=args[0]==='--apply'
  const environment=required('TARGET_ENVIRONMENT').toLowerCase()
  const rootDomain=required('ROOT_DOMAIN').toLowerCase()
  const tenantSlug=required('TENANT_SLUG').toLowerCase()
  const email=required('INITIAL_OWNER_EMAIL').toLowerCase()
  const name=required('INITIAL_OWNER_NAME')
  const databaseUrl=required('TARGET_DATABASE_URL')
  const config={deploymentMode:'managed',tenancyMode:'multi',runtimeEnvironment:environment,rootDomain}
  if(!['uat','test'].includes(environment) || !isValidCustomerSlug(tenantSlug)
    || !validInvitationEmail(email) || name.length<2 || name.length>120) {
    throw new Error('Invalid sandbox environment, customer slug or invitee.')
  }
  const url=new URL(databaseUrl)
  if(!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname) {
    throw new Error('An explicit target PostgreSQL URL is required.')
  }
  const client=new pg.Client({
    connectionString:databaseUrl,connectionTimeoutMillis:5000,
    application_name:'hi5-initial-owner-'+randomUUID().slice(0,8),
  })
  let active=false
  try {
    await client.connect()
    await client.query(apply?'BEGIN':'BEGIN READ ONLY')
    active=true
    await client.query("SET LOCAL statement_timeout='12000ms'")
    await client.query("SET LOCAL lock_timeout='4000ms'")
    const identity=(await client.query(
      `SELECT environment,root_domain,instance_id,verified_by,verified_at
         FROM managed_runtime_database_identity WHERE singleton=true`,
    )).rows[0]||null
    const checked=validateRuntimeAttestation(config,identity)
    if(!checked.allowed) throw new Error('Target database attestation rejected: '+checked.errors.join('; '))

    const result=await client.query(
      `SELECT t.id,t.slug,t.status,t.company_name,ts.tenant_url,ts.modules,
        b.local_tenant_id,b.control_request_id,b.environment,b.stage,
        a.tenant_id AS approval_tenant_id,a.bootstrap_request_id,
        a.state AS approval_state,a.approved_by,a.approved_at
        FROM tenants t
        JOIN tenant_settings ts ON ts.tenant_id=t.id
        LEFT JOIN managed_environment_tenant_bootstrap b ON b.local_tenant_id=t.id
        LEFT JOIN managed_environment_access_approvals a ON a.tenant_id=t.id
        WHERE t.slug=$1
        ${apply?'FOR UPDATE OF t':''}`,
      [tenantSlug],
    )
    const row=result.rows[0]
    if(!row) throw new Error('Sandbox tenant does not exist.')
    const gate=sandboxInvitationGate(config,row,{
      local_tenant_id:row.local_tenant_id,control_request_id:row.control_request_id,
      environment:row.environment,stage:row.stage,
    },{
      tenant_id:row.approval_tenant_id,bootstrap_request_id:row.bootstrap_request_id,
      state:row.approval_state,approved_by:row.approved_by,approved_at:row.approved_at,
    },row.modules)
    if(!gate.allowed) throw new Error('Tenant not approved for invitation: '+gate.reason)

    const owner=(await client.query(
      `SELECT 1 FROM tenant_memberships
        WHERE tenant_id=$1 AND role='owner' LIMIT 1`,[row.id],
    )).rowCount>0
    if(owner) throw new Error('Tenant already has an owner; use scoped member invitations.')
    const existing=(await client.query(
      `SELECT 1 FROM managed_environment_invitations
        WHERE tenant_id=$1 AND role='owner' AND accepted_at IS NULL
          AND revoked_at IS NULL AND expires_at>now() LIMIT 1`,[row.id],
    )).rowCount>0
    if(existing) throw new Error('An unexpired initial owner invitation already exists.')

    const summary={environment,tenantSlug,tenantId:row.id,databaseInstanceId:identity.instance_id,
      inviteeEmail:email,role:'owner',mode:apply?'apply':'check',
      tenantActive:true,independentlyApproved:true,sessionCreated:false}
    if(!apply){
      await client.query('ROLLBACK');active=false
      console.log(JSON.stringify({...summary,result:'eligible_for_operator_invitation'},null,2))
      return
    }
    if(required('CONFIRM_SANDBOX_OWNER_INVITATION')!==`${tenantSlug}:${environment}:${row.id}`) {
      throw new Error('Owner invitation confirmation must match slug:environment:tenant UUID.')
    }
    await client.query(
      `UPDATE managed_environment_invitations SET revoked_at=now()
        WHERE tenant_id=$1 AND email=$2 AND accepted_at IS NULL
          AND revoked_at IS NULL AND expires_at<=now()`,[row.id,email],
    )
    const token=invitationToken()
    const invited=await client.query(
      `INSERT INTO managed_environment_invitations
        (tenant_id,email,name,role,token_hash,expires_at)
       VALUES ($1,$2,$3,'owner',$4,now()+make_interval(hours=>$5::int))
       RETURNING id,expires_at`,
      [row.id,email,name,invitationHash(token),INVITATION_TTL_HOURS],
    )
    await client.query('COMMIT');active=false
    try{
      await sendManagedSandboxInvitationEmail({
        to:email,name,companyName:row.company_name,role:'owner',token,
        tenantUrl:row.tenant_url,environment,
      })
    }catch(error){
      await client.query(
        'UPDATE managed_environment_invitations SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL',
        [invited.rows[0].id],
      ).catch(()=>{})
      throw new Error('Initial invitation email failed; invitation revoked or requires reconciliation.',{cause:error})
    }
    // Token never appears in the CLI logs, database or response.
    console.log(JSON.stringify({...summary,result:'invitation_sent',expiresAt:invited.rows[0].expires_at},null,2))
  }finally{
    if(active) await client.query('ROLLBACK').catch(()=>{})
    await client.end().catch(()=>{})
  }
}
run().catch(error=>{console.error('Initial owner invitation blocked:',error.message);process.exitCode=1})
