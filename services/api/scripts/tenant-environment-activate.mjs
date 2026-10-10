import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createClient } from 'redis'
import { isValidCustomerSlug } from '../src/tenantEnvironmentHostnames.js'
import { readOperatorTrustFile, verifyOperatorPair } from '../src/managedOperatorEvidence.js'
import { validateControlPlaneAttestation } from '../src/tenantEnvironmentOperatorChecks.js'
import {
  validateRuntimeAttestation, validateManagedRuntimeRedisIdentity,
  MANAGED_RUNTIME_REDIS_IDENTITY_KEY,
} from '../src/managedRuntimeGuard.js'

// Privileged external operator command; never called from the web API.
// No DNS, central "ready" status, RMM or Production change is performed.
function required(name) {
  const value=String(process.env[name]||'').trim()
  if(!value) throw new Error(name+' must be explicitly configured.')
  return value
}
function endpoint(url) {
  const u=new URL(url)
  if(!['postgres:','postgresql:'].includes(u.protocol) || !u.hostname || u.pathname==='/') {
    throw new Error('Explicit PostgreSQL database and host required.')
  }
  return [u.hostname.toLowerCase(),u.port||'5432',u.pathname.toLowerCase()].join(':')
}
async function main() {
  const mode=process.argv[2] || '--check'
  if(!['--check','--approve','--activate','--suspend'].includes(mode) || process.argv.length>3) {
    throw new Error('Usage: tenant-environment-activate.mjs [--check|--approve|--activate|--suspend]')
  }
  const environment=required('TARGET_ENVIRONMENT').toLowerCase()
  const rootDomain=required('ROOT_DOMAIN').toLowerCase()
  const slug=required('TENANT_SLUG').toLowerCase()
  const controlUrl=required('CONTROL_DATABASE_URL')
  const targetUrl=required('TARGET_DATABASE_URL')
  const redisUrl=required('TARGET_REDIS_URL')
  if(!['uat','test'].includes(environment) || !isValidCustomerSlug(slug)
    || !/^[a-z0-9.-]+$/.test(rootDomain)) throw new Error('Invalid sandbox environment or hostname.')
  if(endpoint(controlUrl)===endpoint(targetUrl)) throw new Error('Control and target databases must not share an endpoint.')
  const config={deploymentMode:'managed',tenancyMode:'multi',runtimeEnvironment:environment,rootDomain}
  const actor=mode==='--check'?'read-only':required('ACTIVATION_OPERATOR')
  const reviewer=mode==='--check'?'read-only':required('INDEPENDENT_REVIEWER')
  if(mode!=='--check' && (actor.length<3 || reviewer.length<3 || actor===reviewer)) {
    throw new Error('Activation requires two different identified operators.')
  }
  const control=new pg.Client({connectionString:controlUrl,connectionTimeoutMillis:5000,
    application_name:'h5-sandbox-control-'+randomUUID().slice(0,8)})
  const target=new pg.Client({connectionString:targetUrl,connectionTimeoutMillis:5000,
    application_name:'h5-sandbox-operator-'+randomUUID().slice(0,8)})
  const redis=createClient({url:redisUrl})
  redis.on('error',()=>{})
  let controlTransaction=false
  let targetTransaction=false
  try {
    await Promise.all([control.connect(),target.connect(),redis.connect()])
    await control.query('BEGIN READ ONLY');controlTransaction=true
    await target.query(mode==='--check'?'BEGIN READ ONLY':'BEGIN');targetTransaction=true
    for(const client of [control,target]) {
      await client.query("SET LOCAL statement_timeout='12000ms'")
      await client.query("SET LOCAL lock_timeout='4000ms'")
    }
    const controlIdentity=(await control.query(
      `SELECT deployment_mode,tenancy_mode,root_domain,instance_id,verified_by,verified_at
       FROM managed_control_plane_identity WHERE singleton=true`,
    )).rows[0]
    const controlReport=validateControlPlaneAttestation(controlIdentity,rootDomain)
    if(!controlReport.allowed) throw new Error('Control-plane identity rejected: '+controlReport.errors.join('; '))
    const targetIdentity=(await target.query(
      `SELECT environment,root_domain,instance_id,verified_by,verified_at
       FROM managed_runtime_database_identity WHERE singleton=true`,
    )).rows[0]
    const targetReport=validateRuntimeAttestation(config,targetIdentity)
    if(!targetReport.allowed) throw new Error('Target database identity rejected: '+targetReport.errors.join('; '))
    if(String(controlIdentity.instance_id)===String(targetIdentity.instance_id)) {
      throw new Error('Control and target databases claim the same instance UUID.')
    }
    const bindingRaw=await redis.get(MANAGED_RUNTIME_REDIS_IDENTITY_KEY)
    let binding
    try { binding=bindingRaw?JSON.parse(bindingRaw):null } catch { binding=null }
    const redisReport=validateManagedRuntimeRedisIdentity(config,targetIdentity,binding)
    if(!redisReport.allowed) throw new Error('Redis environment identity rejected: '+redisReport.errors.join('; '))
    const request=(await control.query(
      `SELECT q.id,q.tenant_id,q.state,q.environment,t.slug,t.status AS control_tenant_status,
              e.provisioning_status,e.hostname_label
         FROM tenant_environment_provision_requests q
         JOIN tenants t ON t.id=q.tenant_id
         JOIN tenant_environment_instances e ON e.tenant_id=t.id AND e.environment=q.environment
        WHERE t.slug=$1 AND q.environment=$2 AND q.state='claimed'
        ORDER BY q.requested_at DESC LIMIT 1`,[slug,environment],
    )).rows[0]
    if(!request || request.control_tenant_status!=='active'
      || request.provisioning_status!=='provisioning'
      || request.hostname_label!==slug+environment) {
      throw new Error('Control plane has no matching claimed/provisioning customer environment.')
    }
    const row=(await target.query(
      `SELECT t.id,t.slug,t.status,t.company_name,ts.modules,ts.tenant_url,
              ts.portal_url,ts.rmm_url,b.control_request_id,b.control_tenant_id,
              b.database_instance_id,b.expected_hostname,b.environment,b.stage,
              a.state AS approval_state,a.approved_by,a.bootstrap_request_id,a.approved_at
         FROM managed_environment_tenant_bootstrap b
         JOIN tenants t ON t.id=b.local_tenant_id
         JOIN tenant_settings ts ON ts.tenant_id=t.id
         LEFT JOIN managed_environment_access_approvals a ON a.tenant_id=t.id
        WHERE t.slug=$1
        ${mode==='--check'?'':'FOR UPDATE OF t,b'}`,[slug],
    )).rows[0]
    if(!row || row.control_request_id!==request.id
      || row.control_tenant_id!==request.tenant_id
      || row.database_instance_id!==targetIdentity.instance_id
      || row.environment!==environment || row.stage!=='identity_prepared'
      || row.expected_hostname!==`${slug}${environment}.${rootDomain}`
      || row.tenant_url!==`https://${slug}${environment}.${rootDomain}`
      || row.portal_url!==`https://${slug}${environment}-portal.${rootDomain}`
      || row.rmm_url!==null || row.modules?.rmm!==false) {
      throw new Error('Target tenant provenance or URLs do not match operator-attested isolation.')
    }
    const report={
      mode,tenantSlug:slug,environment,controlRequestId:request.id,
      localTenantId:row.id,tenantStatus:row.status,
      approved:row.approval_state==='approved',
      mfaMandatory:true,rmmEnabled:false,
      databaseInstanceId:targetIdentity.instance_id,
      redisInstanceId:binding.redisInstanceId,
      controlPlaneState:request.state,
      controlPlaneReady:false,
      dnsChanged:false,
    }
    if(mode==='--check') {
      await target.query('ROLLBACK');targetTransaction=false
      await control.query('ROLLBACK');controlTransaction=false
      console.log(JSON.stringify(report,null,2))
      return
    }
    const confirmation=`${slug}:${environment}:${request.id}:${mode.slice(2)}`
    if(required('CONFIRM_SANDBOX_ACTIVATION')!==confirmation) {
      throw new Error('Confirmation must exactly match slug:environment:requestId:action.')
    }
    // The operator/reviewer names in environment variables are NEVER sufficient
    // to authorize a mutation. Require independent, time-limited Ed25519
    // assertions signed by identities in an externally provisioned trust file.
    const trust=readOperatorTrustFile(required('SANDBOX_OPERATOR_TRUST_FILE'))
    const evidence=verifyOperatorPair({
      trust,
      actorToken:required('ACTIVATION_ACTOR_ATTESTATION'),
      reviewerToken:required('ACTIVATION_REVIEWER_ATTESTATION'),
      expected:{
        action:mode.slice(2),actor,reviewer,tenantSlug:slug,environment,
        controlRequestId:request.id,localTenantId:row.id,
        databaseInstanceId:targetIdentity.instance_id,
        redisInstanceId:binding.redisInstanceId,
      },
    })
    if(mode==='--approve') {
      if(row.status!=='suspended' || row.approval_state==='approved') {
        throw new Error('Only suspended, not-yet-approved tenants may be approved.')
      }
      // REVIEWER identity must be the independent change reviewer,
      // while actor is the privileged operator applying the approval.
      await target.query(
        `INSERT INTO managed_environment_access_approvals
           (tenant_id,bootstrap_request_id,state,approved_by,approved_at)
         VALUES ($1,$2,'approved',$3,now())
         ON CONFLICT (tenant_id) DO UPDATE SET
            bootstrap_request_id=EXCLUDED.bootstrap_request_id,
            state='approved',approved_by=EXCLUDED.approved_by,
            approved_at=EXCLUDED.approved_at,reviewed_at=now()`,
        [row.id,request.id,reviewer],
      )
    } else if(mode==='--activate') {
      if(row.status!=='suspended' || row.approval_state!=='approved'
        || row.approved_by!==reviewer || actor===row.approved_by) {
        throw new Error('Activation requires a suspended tenant and independent existing approval.')
      }
      const approvalAudit=(await target.query(
        `SELECT operator_id,independent_reviewer_id,actor_evidence_sha256,reviewer_evidence_sha256,
                actor_key_id,reviewer_key_id
           FROM managed_environment_activation_audit
          WHERE tenant_id=$1 AND bootstrap_request_id=$2 AND environment=$3
            AND action='approve'
          ORDER BY created_at DESC,id DESC LIMIT 1`,
        [row.id,request.id,environment],
      )).rows[0]
      // A different name in another ENV variable is not two-person control.
      // The activating operator must be distinct from BOTH people who signed
      // the approval and must reference that durable approval audit event.
      if(!approvalAudit || approvalAudit.independent_reviewer_id!==reviewer
        || !approvalAudit.actor_evidence_sha256 || !approvalAudit.reviewer_evidence_sha256
        || !approvalAudit.actor_key_id || !approvalAudit.reviewer_key_id
        || actor===approvalAudit.operator_id || actor===approvalAudit.independent_reviewer_id
        || evidence.actor.keyId===approvalAudit.actor_key_id
        || evidence.actor.keyId===approvalAudit.reviewer_key_id) {
        throw new Error('Activation requires a different operator from both approval participants.')
      }
      await target.query("UPDATE tenants SET status='active',updated_at=now() WHERE id=$1 AND status='suspended'",[row.id])
    } else {
      if(row.status!=='active' || row.approval_state!=='approved') {
        throw new Error('Only active approved environments can be suspended.')
      }
      await target.query("UPDATE tenants SET status='suspended',updated_at=now() WHERE id=$1",[row.id])
      await target.query(
        "UPDATE managed_environment_access_approvals SET state='revoked',reviewed_at=now() WHERE tenant_id=$1",
        [row.id],
      )
      await target.query(
        "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND revoked_at IS NULL",
        [row.id],
      )
      await target.query(
        "UPDATE managed_environment_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND accepted_at IS NULL",
        [row.id],
      )
    }
    await target.query(
      `INSERT INTO managed_environment_activation_audit
         (tenant_id,bootstrap_request_id,environment,action,operator_id,
          independent_reviewer_id,attested_database_instance_id,attested_redis_instance_id,
          actor_evidence_sha256,reviewer_evidence_sha256,actor_key_id,reviewer_key_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.id,request.id,environment,mode.slice(2),actor,reviewer,
        targetIdentity.instance_id,binding.redisInstanceId,
        evidence.actor.digest,evidence.reviewer.digest,
        evidence.actor.keyId,evidence.reviewer.keyId],
    )
    await target.query('COMMIT');targetTransaction=false
    await control.query('ROLLBACK');controlTransaction=false
    console.log(JSON.stringify({...report,result:mode.slice(2)+'_committed',
      controlPlaneReady:false,dnsChanged:false},null,2))
  } finally {
    if(targetTransaction) await target.query('ROLLBACK').catch(()=>{})
    if(controlTransaction) await control.query('ROLLBACK').catch(()=>{})
    await Promise.allSettled([control.end(),target.end(),redis.quit()])
  }
}
main().catch(e=>{console.error('Managed sandbox activation blocked:',e.message);process.exitCode=1})
