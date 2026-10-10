import assert from 'node:assert/strict'
import pg from 'pg'
import {randomBytes,createHash} from 'node:crypto'

const url=new URL(process.env.DATABASE_URL||'')
assert.equal(url.hostname,'shadow-postgres')
assert.equal(url.pathname,'/phase22_shadow')
assert.equal(process.env.PLATFORM_ADMIN_MFA_REQUIRED,'true')
assert.equal(process.env.BACKGROUND_WORKERS_ENABLED,'false')
const client=new pg.Client({connectionString:process.env.DATABASE_URL})
await client.connect()
const rawToken=randomBytes(32).toString('base64url')
const tokenHash=createHash('sha256').update(rawToken).digest('hex')
const email='phase22-shadow-'+randomBytes(5).toString('hex')+'@example.invalid'
let id
try {
 const baseline=(await client.query("SELECT COUNT(*)::int AS tenants FROM tenants")).rows[0].tenants
 assert.equal(baseline,4)
 // The fixture only exists in the disposable shadow database and is removed
 // in finally. Do not read or print existing account credentials or PII.
 const created=await client.query(
   "INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,'Synthetic Shadow Admin','no-login-shadow-only',now()) RETURNING id",
   [email])
 id=created.rows[0].id
 await client.query("INSERT INTO platform_admin_members(user_id,role,status) VALUES($1,'owner','active')",[id])
 await client.query(
   "INSERT INTO platform_admin_sessions(user_id,token_hash,expires_at,mfa_verified_at) VALUES($1,$2,now()+interval '2 minutes',now())",
   [id,tokenHash])
 const c='hi5central_admin_session='+rawToken
 async function request(method,path,body) {
   const r=await fetch('http://127.0.0.1:3001'+path,{
     method,headers:{Cookie:c,Origin:'https://pilot-admin.hi5central.com','Content-Type':'application/json'},
     body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',
     signal:AbortSignal.timeout(4500)})
   return {status:r.status,data:await r.json().catch(()=>({}))}
 }
 const tenants=await request('GET','/api/platform/v1/tenants')
 assert.equal(tenants.status,200,JSON.stringify({status:tenants.status,error:tenants.data.error}))
 assert.equal(tenants.data.items.length,4)
 assert.equal(tenants.data.items.filter(x=>Boolean(x.owner_user_id)).length,3)
 assert.ok(tenants.data.items.every(x=>Array.isArray(x.environments)))
 const noOwner=await request('POST','/api/platform/v1/tenants',{
   companyName:'Should Reject',slug:'phase22-no-owner',updateMode:'admin_controlled',
 })
 assert.equal(noOwner.status,400,'No tenant should be created without a validated first owner')
 const postCount=(await client.query("SELECT COUNT(*)::int AS tenants FROM tenants")).rows[0].tenants
 assert.equal(postCount,4)
 console.log('PHASE22_UPGRADED_API_PROD_SHADOW: PASS')
 console.log('Four existing tenants and three owner memberships visible through new authenticated Admin API; invalid onboarding rejected; no tenant writes')
}finally {
 if(id)await client.query('DELETE FROM users WHERE id=$1',[id])
 await client.end()
}