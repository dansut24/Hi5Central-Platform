import pg from 'pg'
import { readFileSync } from 'node:fs'
import { deployment } from './deploymentConfig.js'
import { pool } from './db.js'

const { Client } = pg
const environments = ['test', 'uat']
const isId = (value) => /^[a-f0-9-]{36}$/i.test(String(value || ''))
const targetUrl = (slug, env, kind = 'workspace') => {
  const prefix = `${slug}-${env}`
  const suffix = kind === 'portal' ? '-portal' : kind === 'rmm' ? '-rmm' : ''
  return `https://${prefix}${suffix}.${String(process.env.ROOT_DOMAIN || 'hi5central.com').trim()}`
}

/**
 * Reuse one Test and one UAT database for all organisations.
 * Environment users authenticate through a short-lived Production identity handoff.
 * No Production password hashes or MFA secrets are transferred.
 * Never expose the source database credentials to browsers or copy live
 * ITSM tickets, devices, secrets, uploaded files or operational records.
 * Destination schemas are provisioned/migrated by the deployment operator.
 * Each environment is committed independently, with an honest status.
 */
export async function provisionTenantSandboxes(tenantId, { source = pool, targets = {} } = {}) {
  if (!isId(tenantId)) throw new Error('A valid tenant ID is required.')
  if (deployment.runtimeEnvironment !== 'live') throw new Error('Only the Live control plane can provision customer sandboxes.')
  const row = await source.query(
    `SELECT t.id,t.slug,t.company_name,t.status,
            ts.modules,ts.onboarding_data,ts.configuration,ts.onboarding_completed_at,
            rp.update_mode
       FROM tenants t
       JOIN tenant_settings ts ON ts.tenant_id=t.id
       JOIN tenant_release_preferences rp ON rp.tenant_id=t.id
      WHERE t.id=$1`, [tenantId],
  )
  if (!row.rowCount || !row.rows[0].onboarding_completed_at || row.rows[0].status !== 'active') {
    throw new Error('Finish onboarding before provisioning Test and UAT.')
  }
  const tenant = row.rows[0]
  // Keep tenant aliases unique and within the existing slug constraint.
  if (tenant.slug.length > 42 || /-(test|uat)$/.test(tenant.slug)) {
    throw new Error('The organisation URL cannot be provisioned as a Test/UAT alias.')
  }
  const members = await source.query(
    `SELECT u.id,u.email,u.name,u.email_verified_at,
            m.role,m.status
       FROM tenant_memberships m
       JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.status='active'
      ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END, u.id`, [tenantId],
  )
  if (!members.rowCount || !members.rows.some(r => r.role === 'owner')) {
    throw new Error('An active organisation owner is required for sandbox access.')
  }
  const summary = {}
  for (const env of environments) {
    const connectionString = targets[env]
      || (process.env[`TENANT_${env.toUpperCase()}_DATABASE_URL_FILE`]
        ? readFileSync(process.env[`TENANT_${env.toUpperCase()}_DATABASE_URL_FILE`],'utf8').trim()
        : process.env[`TENANT_${env.toUpperCase()}_DATABASE_URL`])
    if (!connectionString) {
      summary[env] = { status: 'error', error: 'Sandbox database connection is not configured.' }
      await source.query(
        `UPDATE tenant_environment_state SET status='error',updated_at=now()
         WHERE tenant_id=$1 AND environment=$2`, [tenantId,env],
      )
      continue
    }
    await source.query(
      `UPDATE tenant_environment_state SET status='provisioning',updated_at=now()
       WHERE tenant_id=$1 AND environment=$2`, [tenantId,env],
    )
    const client = new Client({ connectionString, connectionTimeoutMillis: 6000 })
    try {
      await client.connect()
      await client.query('BEGIN')
      const slug = `${tenant.slug}-${env}`
      // Explicit origin and tenant ID checks avoid repurposing another tenant.
      const collision = await client.query(
        'SELECT id FROM tenants WHERE slug=$1 OR id=$2', [slug,tenant.id],
      )
      if (collision.rows.some(t => t.id !== tenant.id)) throw new Error('Sandbox tenant slug collision.')
      await client.query(
        `INSERT INTO tenants(id,slug,company_name,status)
         VALUES($1,$2,$3,'active')
         ON CONFLICT(id) DO UPDATE SET
           company_name=EXCLUDED.company_name,updated_at=now()`,
        [tenant.id,slug,tenant.company_name],
      )
      for (const user of members.rows) {
        await client.query(
          `INSERT INTO users(id,email,name,password_hash,email_verified_at)
           VALUES($1,$2,$3,'environment-sso-only',$4)
           ON CONFLICT(id) DO NOTHING`,
          [user.id,user.email,user.name,user.email_verified_at],
        )
        const identity = await client.query('SELECT email FROM users WHERE id=$1',[user.id])
        if (!identity.rowCount || identity.rows[0].email !== user.email) {
          throw new Error('Sandbox account identity conflict.')
        }
        await client.query(
          `INSERT INTO tenant_memberships(tenant_id,user_id,role,status)
           VALUES($1,$2,$3,'active')
           ON CONFLICT(tenant_id,user_id) DO UPDATE SET
             role=EXCLUDED.role,status='active'`,
          [tenant.id,user.id,user.role],
        )
      }
      const configuration = tenant.configuration && Object.keys(tenant.configuration).length
        ? tenant.configuration : tenant.onboarding_data
      await client.query(
        `INSERT INTO tenant_settings
            (tenant_id,modules,onboarding_step,onboarding_completed_at,onboarding_data,
             configuration,tenant_url,portal_url,rmm_url)
         VALUES($1,$2::jsonb,'complete',now(),$3::jsonb,$4::jsonb,$5,$6,$7)
         ON CONFLICT(tenant_id) DO NOTHING`,
        [tenant.id,JSON.stringify(tenant.modules),JSON.stringify(tenant.onboarding_data),
         JSON.stringify(configuration),targetUrl(tenant.slug,env),
         targetUrl(tenant.slug,env,'portal'),
         tenant.modules?.rmm ? targetUrl(tenant.slug,env,'rmm') : null],
      )
      await client.query('COMMIT')
      await source.query(
        `UPDATE tenant_environment_state SET status='ready',last_deployed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND environment=$2`, [tenantId,env],
      )
      summary[env] = { status:'ready',url:targetUrl(tenant.slug,env) }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      await source.query(
        `UPDATE tenant_environment_state SET status='error',updated_at=now()
         WHERE tenant_id=$1 AND environment=$2`, [tenantId,env],
      )
      summary[env] = { status:'error',error:'Sandbox provisioning failed. Check server logs.' }
      console.error('Tenant environment provisioning failed', { environment: env, tenantId, code:error.code || 'UNKNOWN', message:error.message })
    } finally {
      await client.end().catch(() => {})
    }
  }
  return summary
}

/**
 * One-time rollout reconciler for existing, already-onboarded organisations.
 * Feature-flagged so only an explicitly approved Live deployment starts it.
 * A failed environment remains 'error' and may be retried by its owner.
 */
export async function backfillCompletedTenantSandboxes({ source = pool } = {}) {
  if (deployment.runtimeEnvironment !== 'live') return { skipped: true }
  const result = await source.query(
    `SELECT t.id
       FROM tenants t
       JOIN tenant_settings ts ON ts.tenant_id=t.id
       JOIN tenant_environment_state te ON te.tenant_id=t.id
      WHERE t.status='active' AND ts.onboarding_completed_at IS NOT NULL
        AND te.environment IN ('test','uat') AND te.status<>'ready'
      GROUP BY t.id ORDER BY t.id LIMIT 100`,
  )
  let ready = 0
  let failed = 0
  for (const row of result.rows) {
    try {
      const status = await provisionTenantSandboxes(row.id, { source })
      for (const env of ['test','uat']) status[env]?.status === 'ready' ? ready++ : failed++
    } catch (error) {
      failed++
      console.error('Backfill environment provisioning failed', {tenantId:row.id,code:error.code || 'UNKNOWN'})
    }
  }
  console.log('Tenant sandbox backfill finished', { tenants:result.rowCount,ready,failed })
  return {tenants:result.rowCount,ready,failed}
}

export function tenantSandboxUrl(slug, env) {
  if (!environments.includes(env) || slug.length > 42 || !/^[a-z0-9][a-z0-9-]+[a-z0-9]$/.test(slug)) return null
  return targetUrl(slug,env)
}
