import { pool } from './db.js'
import { deployment } from './deploymentConfig.js'
import { sendOnboardingCompletionEmail } from './mailer.js'

let running = false
let scheduler = null
const isUuid = value => /^[0-9a-f-]{36}$/i.test(String(value || ''))

export function workspaceLinks(slug, mode, rootDomain = 'hi5central.com') {
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(String(slug)) ||
      !/^[a-z0-9.-]+$/.test(String(rootDomain))) throw new Error('Invalid workspace host')
  const root = String(rootDomain).toLowerCase()
  return [
    { environment:'live', label:'Production', url:`https://${slug}.${root}`,
      description:'Your day-to-day workspace for real work and requests' },
    { environment:'test', label:'Test', url:`https://${slug}-test.${root}`,
      description:'Restricted preview of the latest features — not a separate working ITSM environment' },
    ...(mode === 'admin_controlled' ? [{
      environment:'uat', label:'UAT', url:`https://${slug}-uat.${root}`,
      description:'Test and approve releases here before moving them to Production',
    }] : []),
  ]
}

export async function queueOnboardingCompletionEmail(db, tenantId, userId) {
  if (!isUuid(tenantId) || !isUuid(userId)) throw new Error('Valid owner and tenant required')
  await db.query(
    `INSERT INTO onboarding_completion_emails(tenant_id,user_id)
     SELECT $1,$2 WHERE EXISTS (
       SELECT 1 FROM tenant_settings s
       JOIN tenant_memberships m ON m.tenant_id=s.tenant_id AND m.user_id=$2
       JOIN users u ON u.id=m.user_id
       WHERE s.tenant_id=$1 AND s.onboarding_completed_at IS NOT NULL
         AND m.role='owner' AND m.status='active' AND u.email_verified_at IS NOT NULL
     )
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId,userId],
  )
}

export async function processOnboardingCompletionEmails({db = pool, limit = 4, send = sendOnboardingCompletionEmail} = {}) {
  if (deployment.runtimeEnvironment !== 'live' || running) return 0
  running = true
  let count = 0
  try {
    for (let index=0;index<Math.min(limit,8);index++) {
      // Atomic claim prevents repeated sends from concurrent API instances.
      // Never claim an unfinished tenant, unverified owner or unavailable UAT.
      const res = await db.query(
        `WITH chosen AS (
           SELECT q.tenant_id FROM onboarding_completion_emails q
           JOIN tenant_settings ts ON ts.tenant_id=q.tenant_id
           JOIN tenant_release_preferences p ON p.tenant_id=q.tenant_id
           JOIN tenant_memberships m ON m.tenant_id=q.tenant_id AND m.user_id=q.user_id
           JOIN users u ON u.id=q.user_id
           WHERE q.attempts < 6
             AND ((q.status IN ('pending','retry') AND q.next_attempt_at <= now())
                  OR (q.status='sending' AND q.claimed_at < now()-interval '15 minutes'))
             AND ts.onboarding_completed_at IS NOT NULL
             AND m.role='owner' AND m.status='active' AND u.email_verified_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM tenant_environment_state e
                 WHERE e.tenant_id=q.tenant_id AND e.environment='live' AND e.status='ready')
             AND EXISTS (SELECT 1 FROM tenant_environment_state e
                 WHERE e.tenant_id=q.tenant_id AND e.environment='test' AND e.status='ready')
             AND (p.update_mode='hi5_managed' OR EXISTS
                  (SELECT 1 FROM tenant_environment_state e
                   WHERE e.tenant_id=q.tenant_id AND e.environment='uat' AND e.status='ready'))
           ORDER BY q.created_at LIMIT 1
           FOR UPDATE OF q SKIP LOCKED
         )
         UPDATE onboarding_completion_emails q
         SET status='sending', attempts=attempts+1,claimed_at=now(),updated_at=now()
         FROM chosen WHERE q.tenant_id=chosen.tenant_id
         RETURNING q.tenant_id,q.user_id,q.attempts`,
      )
      const job = res.rows[0]
      if (!job) break
      try {
        const r = await db.query(
          `SELECT t.slug,t.company_name,p.update_mode,u.email,u.name
           FROM onboarding_completion_emails q
           JOIN tenants t ON t.id=q.tenant_id
           JOIN tenant_release_preferences p ON p.tenant_id=t.id
           JOIN users u ON u.id=q.user_id
           WHERE q.tenant_id=$1 AND t.status='active'`,
          [job.tenant_id],
        )
        const account=r.rows[0]
        if (!account) throw new Error('Tenant or owner inactive')
        await send({
          to:account.email,name:account.name,companyName:account.company_name,
          updateMode:account.update_mode,
          environments:workspaceLinks(account.slug,account.update_mode,deployment.rootDomain),
        })
        await db.query(
          `UPDATE onboarding_completion_emails
           SET status='sent',sent_at=now(),claimed_at=NULL,last_error=NULL,updated_at=now()
           WHERE tenant_id=$1 AND status='sending'`,[job.tenant_id],
        )
        count++
      } catch (error) {
        await db.query(
          `UPDATE onboarding_completion_emails SET status='retry',
             claimed_at=NULL,last_error=$2,
             next_attempt_at=now()+
               (LEAST(360,POWER(2,LEAST(attempts,7))*2)::integer * interval '1 minute'),
             updated_at=now()
           WHERE tenant_id=$1 AND status='sending'`,
          [job.tenant_id,String(error?.code || error?.message || 'SMTP error').slice(0,200)],
        )
        console.error('Onboarding completion email failed', {
          tenantId:job.tenant_id,attempt:job.attempts,code:error?.code || 'DELIVERY_FAILED',
        })
      }
    }
    return count
  } finally {
    running = false
  }
}

export function startOnboardingCompletionMailer() {
  if (scheduler || deployment.runtimeEnvironment !== 'live') return
  scheduler = setInterval(() => {
    void processOnboardingCompletionEmails().catch(error =>
      console.error('Onboarding email scheduler failed',{code:error.code || 'UNKNOWN'}))
  },60000)
  scheduler.unref?.()
  void processOnboardingCompletionEmails().catch(error =>
    console.error('Initial onboarding email check failed',{code:error.code || 'UNKNOWN'}))
}
