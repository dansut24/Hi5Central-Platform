import {pool} from './db.js'
import {mfaRequiredFor} from './securityPolicy.js'

// The sandbox decides whether *its* policy requires central identity MFA.
// No password hashes, MFA secrets or challenge tokens are stored in the
// sandbox. Only central identity is permitted to create/verify challenges.
export async function sandboxRequiresMfaForLogin(tenantSlug,email,{db=pool}={}) {
  const slug=String(tenantSlug||'').trim().toLowerCase()
  const normalizedEmail=String(email||'').trim().toLowerCase()
  const result=await db.query(
    `SELECT m.role AS tenant_role,ts.configuration,ts.onboarding_data,ts.onboarding_completed_at
       FROM tenants t
       JOIN tenant_settings ts ON ts.tenant_id=t.id
       JOIN tenant_memberships m ON m.tenant_id=t.id
       JOIN users u ON u.id=m.user_id
      WHERE t.slug=$1 AND lower(u.email)=$2
        AND t.status='active' AND m.status='active'
      LIMIT 1`,
    [slug,normalizedEmail],
  )
  return Boolean(result.rows[0] && mfaRequiredFor(result.rows[0]))
}
