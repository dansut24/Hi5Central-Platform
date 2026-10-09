import { isManagedCustomerSandbox } from './managedSandboxPolicy.js'
import { sandboxInvitationGate } from './managedSandboxInvitations.js'

// Authoritative per-request access check. A revoked environment approval,
// mismatched database identity or suspended tenant immediately denies existing
// sessions as well as MFA challenges. Never cache this gate in Redis.
export async function sandboxTenantAccess(db, config, tenantId) {
  if (!isManagedCustomerSandbox(config)) return true
  if (!tenantId) return false
  const result = await db.query(
    `SELECT t.id,t.slug,t.status,ts.tenant_url,ts.portal_url,ts.rmm_url,ts.modules,
            ri.instance_id AS runtime_database_instance_id,
            b.local_tenant_id,b.control_request_id,b.database_instance_id,b.expected_hostname,
            b.environment,b.stage,
            a.tenant_id AS approval_tenant_id,a.bootstrap_request_id,
            a.state AS approval_state,a.approved_by,a.approved_at
       FROM tenants t
       JOIN tenant_settings ts ON ts.tenant_id=t.id
       JOIN managed_runtime_database_identity ri ON ri.singleton=true
       JOIN managed_environment_tenant_bootstrap b ON b.local_tenant_id=t.id
       JOIN managed_environment_access_approvals a ON a.tenant_id=t.id
      WHERE t.id=$1 AND ri.environment=$2 AND ri.root_domain=$3 LIMIT 1`,
    [tenantId,config.runtimeEnvironment,config.rootDomain],
  )
  const row=result.rows[0]
  if (!row) return false
  return sandboxInvitationGate(config,row,{
    local_tenant_id:row.local_tenant_id,
    control_request_id:row.control_request_id,
    database_instance_id:row.database_instance_id,
    expected_hostname:row.expected_hostname,
    environment:row.environment,stage:row.stage,
  },{
    tenant_id:row.approval_tenant_id,
    bootstrap_request_id:row.bootstrap_request_id,
    state:row.approval_state,approved_by:row.approved_by,
    approved_at:row.approved_at,
  },row.modules).allowed
}
