import {pool} from '../src/db.js'
import {queueOnboardingCompletionEmail,processOnboardingCompletionEmails} from '../src/onboardingCompletionEmail.js'

// Audited operator CLI. Slugs are supplied explicitly; no automatic backfill
// of unrelated pre-existing customers during a release or migration.
const slugs=process.argv.slice(2)
if(slugs.length>6||slugs.some(x=>!/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(x))) {
  console.error('Usage: node dist/deliver-onboarding-completion.mjs [tenant-slug ...]')
  process.exit(2)
}
try {
  for(const slug of slugs) {
    const r=await pool.query(
      `SELECT t.id AS tenant_id,m.user_id
       FROM tenants t
       JOIN tenant_settings ts ON ts.tenant_id=t.id
       JOIN tenant_memberships m ON m.tenant_id=t.id AND m.role='owner' AND m.status='active'
       JOIN users u ON u.id=m.user_id AND u.email_verified_at IS NOT NULL
       WHERE t.slug=$1 AND t.status='active' AND ts.onboarding_completed_at IS NOT NULL
       ORDER BY m.created_at LIMIT 1`,[slug],
    )
    if(!r.rowCount)throw Error('No verified completed owner for '+slug)
    await queueOnboardingCompletionEmail(pool,r.rows[0].tenant_id,r.rows[0].user_id)
    console.log('CONFIRMED_COMPLETION_QUEUE',slug)
  }
  const count=await processOnboardingCompletionEmails({limit:8})
  console.log('ONBOARDING_EMAIL_DELIVERIES',count)
  for(const slug of slugs){
    const r=await pool.query(
      `SELECT q.status,q.attempts,q.sent_at IS NOT NULL AS sent,
         q.last_error IS NOT NULL AS delivery_failed
       FROM onboarding_completion_emails q JOIN tenants t ON t.id=q.tenant_id
       WHERE t.slug=$1`,[slug],
    )
    console.log('ONBOARDING_EMAIL_STATUS',slug,JSON.stringify(r.rows[0]||null))
  }
} catch(e) {
  console.error('ONBOARDING_EMAIL_DELIVERY_ERROR',e.code||e.message)
  process.exitCode=1
} finally {
  await pool.end()
}
