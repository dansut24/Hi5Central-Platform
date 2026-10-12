import {createHash,randomBytes} from 'node:crypto'
import {pool,withTransaction} from './db.js'
import {verifyPassword} from './password.js'
import {ensureRedisConnected} from './redis.js'
import {sendMfaRecoveryEmail} from './mailer.js'
import {recordSecurityEvent,requestIp,requestUserAgent} from './securityAudit.js'
import {mfaRecoveryStartHtml,mfaRecoveryConfirmHtml} from './mfaRecoveryPages.js'

const PILOT_SLUG=String(process.env.MFA_RECOVERY_PILOT_TENANT_SLUG||'').trim().toLowerCase()
const PILOT_ORIGIN='https://api.hi5central.com'
const EXPIRE_SECONDS=15*60
const generic={status:'accepted',message:'If those credentials match the active account, a recovery email will arrive shortly.'}
const digest=s=>createHash('sha256').update(String(s||'')).digest('hex')
const safeEmail=e=>String(e||'').trim().toLowerCase().slice(0,254)
const validToken=t=>/^[A-Za-z0-9_-]{35,100}$/.test(t)
const tokenKey=t=>'hi5:mfa-recovery:token:'+digest(t)
const throttleKey=(email,ip)=>'hi5:mfa-recovery:rate:'+digest(email+':'+ip)
function page(c,html) {
 c.header('Cache-Control','no-store, max-age=0')
 c.header('Referrer-Policy','no-referrer')
 c.header('X-Content-Type-Options','nosniff')
 c.header('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
 return c.html(html)
}
function permitted(c) {
 return PILOT_SLUG==='testing' && c.req.header('origin')===PILOT_ORIGIN &&
   c.req.header('host')==='api.hi5central.com'
}
async function account(email) {
 const r=await pool.query(
  "SELECT t.id AS tenant_id,u.id AS user_id,u.email,u.name,u.password_hash,u.email_verified_at,m.role,m.status AS membership_status FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id JOIN users u ON u.id=m.user_id WHERE t.slug=$1 AND t.status='active' AND lower(u.email)=$2 LIMIT 1",
  [PILOT_SLUG,email])
 const a=r.rows[0]
 return a?.membership_status==='active' && a.role==='owner' && a.email_verified_at ? a : null
}
export function registerMfaRecoveryRoutes(app) {
 app.get('/api/v1/auth/mfa-recovery/start',c=>{
   if(PILOT_SLUG!=='testing')return c.json({error:'Not available'},404)
   return page(c,mfaRecoveryStartHtml)
 })
 app.get('/api/v1/auth/mfa-recovery/confirm',c=>{
   if(PILOT_SLUG!=='testing')return c.json({error:'Not available'},404)
   return page(c,mfaRecoveryConfirmHtml)
 })
 app.post('/api/v1/auth/mfa-recovery/request',async c=>{
   if(!permitted(c))return c.json({error:'Not available'},404)
   let body
   try{body=await c.req.json()}catch{return c.json(generic,202)}
   const email=safeEmail(body?.email),password=String(body?.password||'')
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length>1024)return c.json(generic,202)
   const redis=await ensureRedisConnected()
   const key=throttleKey(email,requestIp(c))
   const requests=await redis.incr(key)
   if(requests===1)await redis.expire(key,3600)
   if(requests>4)return c.json(generic,202)
   const a=await account(email)
   if(!a||!await verifyPassword(password,a.password_hash))return c.json(generic,202)
   const exists=await pool.query(
    "SELECT 1 FROM user_mfa_methods WHERE tenant_id=$1 AND user_id=$2 AND method='totp' AND enabled=true AND verified_at IS NOT NULL",
    [a.tenant_id,a.user_id])
   if(exists.rowCount!==1)return c.json(generic,202)
   const token=randomBytes(32).toString('base64url'),keyForToken=tokenKey(token)
   await redis.set(keyForToken,JSON.stringify({tenantId:a.tenant_id,userId:a.user_id}),{EX:EXPIRE_SECONDS,NX:true})
   try{
     await sendMfaRecoveryEmail({to:a.email,name:a.name,token})
     await recordSecurityEvent({tenantId:a.tenant_id,actorUserId:a.user_id,eventType:'mfa.recovery_requested',ipAddress:requestIp(c),userAgent:requestUserAgent(c)})
   }catch(e){
     await redis.del(keyForToken)
     console.error('MFA recovery delivery failed',{code:e.code||'SMTP_DELIVERY_ERROR'})
   }
   return c.json(generic,202)
 })
 app.post('/api/v1/auth/mfa-recovery/complete',async c=>{
   if(!permitted(c))return c.json({error:'Not available'},404)
   const invalid={error:'This recovery link is invalid, expired or could not be verified.'}
   let body
   try{body=await c.req.json()}catch{return c.json(invalid,400)}
   const token=String(body?.token||''),password=String(body?.password||'')
   if(!validToken(token)||!password||password.length>1024)return c.json(invalid,400)
   const redis=await ensureRedisConnected(),key=tokenKey(token)
   const stored=await redis.get(key)
   if(!stored)return c.json(invalid,400)
   let target
   try{target=JSON.parse(stored)}catch{return c.json(invalid,400)}
   if(!/^[0-9a-f-]{36}$/i.test(String(target.tenantId))||!/^[0-9a-f-]{36}$/i.test(String(target.userId)))return c.json(invalid,400)
   const lookup=await pool.query(
    "SELECT u.password_hash,t.slug,t.status AS tenant_status,m.role,m.status AS membership_status,u.email_verified_at FROM users u JOIN tenant_memberships m ON m.user_id=u.id JOIN tenants t ON t.id=m.tenant_id WHERE t.id=$1 AND u.id=$2",
    [target.tenantId,target.userId])
   const a=lookup.rows[0]
   if(!a||a.slug!==PILOT_SLUG||a.tenant_status!=='active'||a.membership_status!=='active'||a.role!=='owner'||!a.email_verified_at||!await verifyPassword(password,a.password_hash)){
     return c.json(invalid,400)
   }
   // Atomic one-time consumption happens only after the password is checked.
   const consumed=await redis.getDel(key)
   if(consumed!==stored)return c.json(invalid,400)
   try{
     const result=await withTransaction(async db=>{
       const removed=await db.query(
        "DELETE FROM user_mfa_methods WHERE tenant_id=$1 AND user_id=$2 AND method='totp' AND enabled=true RETURNING method",
        [target.tenantId,target.userId])
       if(removed.rowCount!==1)throw Error('MFA factor is not available for replacement')
       const challenges=await db.query(
        "UPDATE auth_mfa_challenges SET used_at=now() WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL",
        [target.tenantId,target.userId])
       const sessions=await db.query(
        "UPDATE auth_sessions SET revoked_at=now(),revoked_reason='mfa_verified_owner_recovery' WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
        [target.tenantId,target.userId])
       await recordSecurityEvent({db,tenantId:target.tenantId,actorUserId:target.userId,eventType:'mfa.recovery_completed',ipAddress:requestIp(c),userAgent:requestUserAgent(c),metadata:{sessionsRevoked:sessions.rowCount,challengesInvalidated:challenges.rowCount}})
       return {reset:true}
     })
     return c.json(result)
   }catch(e){
     console.error('MFA recovery update failed',{code:e.code||'TRANSACTION_FAILED'})
     return c.json({error:'Recovery could not be completed. Please request a fresh link.'},503)
   }
 })
}
