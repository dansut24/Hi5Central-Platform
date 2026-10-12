import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {Client} from 'pg'
import {queueOnboardingCompletionEmail,workspaceLinks} from '../src/onboardingCompletionEmail.js'
const m=workspaceLinks('managed-example','hi5_managed')
const c=workspaceLinks('custom-example','admin_controlled')
assert.deepEqual(m.map(x=>x.environment),['live','test'])
assert.deepEqual(c.map(x=>x.environment),['live','test','uat'])
assert.equal(m[1].url,'https://managed-example-test.hi5central.com')
assert.equal(c[2].url,'https://custom-example-uat.hi5central.com')
assert.throws(()=>workspaceLinks('../sneaky','admin_controlled'),/Invalid workspace host/)

const db=new Client({connectionString:process.env.DATABASE_URL})
await db.connect()
await db.query('BEGIN')
try {
 const slug='mail-regression-'+randomBytes(4).toString('hex')
 const [t,u]=await Promise.all([
   db.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,'Mail Regression','active') RETURNING id",[slug]),
   db.query("INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,'Email Test','no-real-login',now()) RETURNING id",[slug+'@example.invalid']),
 ])
 const tenantId=t.rows[0].id,userId=u.rows[0].id
 await db.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'owner','active')",[tenantId,userId])
 await db.query("INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,onboarding_data,configuration,onboarding_completed_at) VALUES($1,'{}','finish','{}','{}',null)",[tenantId])
 await queueOnboardingCompletionEmail(db,tenantId,userId)
 let queued=await db.query('SELECT count(*)::int AS n FROM onboarding_completion_emails WHERE tenant_id=$1',[tenantId])
 assert.equal(queued.rows[0].n,0,'Unfinished tenant must not queue an email')
 await db.query("UPDATE tenant_settings SET onboarding_step='complete',onboarding_completed_at=now() WHERE tenant_id=$1",[tenantId])
 await queueOnboardingCompletionEmail(db,tenantId,userId)
 await queueOnboardingCompletionEmail(db,tenantId,userId)
 queued=await db.query('SELECT status,count(*)::int AS n FROM onboarding_completion_emails WHERE tenant_id=$1 GROUP BY status',[tenantId])
 assert.deepEqual(queued.rows,[{status:'pending',n:1}],'Completion email is queued once')
 await db.query("UPDATE users SET email_verified_at=NULL WHERE id=$1",[userId])
 const extra=await db.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,'Second Mail Regression','active') RETURNING id",[slug+'-two'])
 await db.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'owner','active')",[extra.rows[0].id,userId])
 await db.query("INSERT INTO tenant_settings(tenant_id,modules,onboarding_step,onboarding_data,configuration,onboarding_completed_at) VALUES($1,'{}','complete','{}','{}',now())",[extra.rows[0].id])
 await queueOnboardingCompletionEmail(db,extra.rows[0].id,userId)
 const unverified=await db.query('SELECT count(*)::int n FROM onboarding_completion_emails WHERE tenant_id=$1',[extra.rows[0].id])
 assert.equal(unverified.rows[0].n,0,'Unverified owner never gets a completion email')
 console.log('PASS: Managed and Custom environment URLs, one email per completed verified tenant, no unfinished/unverified emails')
} finally {
 await db.query('ROLLBACK')
 await db.end()
}
