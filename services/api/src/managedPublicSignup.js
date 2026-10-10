import {createHash,randomBytes} from 'node:crypto'
import {pool,withTransaction} from './db.js'
import {ensureRedisConnected} from './redis.js'
import {deployment} from './deploymentConfig.js'
import {validateManagedSignupRequest} from './managedSignupValidation.js'
import {sendManagedSignupRequestVerificationEmail} from './mailer.js'

const hash=token=>createHash('sha256').update(token).digest('hex')
const restricted=()=>process.env.MANAGED_SIGNUP_REQUESTS_ENABLED==='true'
  && process.env.DEPLOYMENT_MODE==='managed'
  && process.env.TENANCY_MODE==='multi'
  && process.env.RUNTIME_ENVIRONMENT==='live'
  && deployment.apiUrl==='https://pilot-control-api.hi5central.com'
  && deployment.adminUrl==='https://pilot-admin.hi5central.com'
const publicOrigin='https://hi5central.com'
export function managedSignupRequestEnabled(){return restricted()}
async function throttle(key,limit=4,seconds=3600) {
  const client=await ensureRedisConnected()
  const count=await client.incr('managed-signup:'+key)
  if(count===1)await client.expire('managed-signup:'+key,seconds)
  return count<=limit
}
export function registerManagedPublicSignupRoutes(app) {
  app.post('/api/v1/public/signup-requests',async(c)=>{
    if(!restricted())return c.json({error:'Managed customer signup is not available.'},404)
    if(c.req.header('origin')!==publicOrigin)return c.json({error:'Origin not allowed.'},403)
    if(Number(c.req.header('content-length')||0)>8192)
      return c.json({error:'Request is too large.'},413)
    let body
    try{body=await c.req.json()}catch{return c.json({error:'Invalid JSON.'},400)}
    let requested
    try{requested=validateManagedSignupRequest(body)}
    catch(error){return c.json({error:error.message},400)}
    const ip=String(c.req.header('x-real-ip')||'unknown').slice(0,80)
    if(!await throttle(hash(ip),3,3600)
      ||!await throttle(hash(requested.ownerEmail),3,86400))
      return c.json({error:'Please try again later.'},429)
    if(!process.env.SMTP_USER||!process.env.SMTP_PASSWORD
      ||process.env.MANAGED_SIGNUP_SMTP_APPROVED!=='true')
      return c.json({error:'Email verification for managed signup is not configured.'},503)
    const existing=await pool.query('SELECT 1 FROM tenants WHERE slug=$1',[requested.slug])
    if(existing.rowCount)return c.json({error:'That customer URL is unavailable.'},409)
    const token=randomBytes(32).toString('base64url')
    const tokenHash=hash(token)
    let requestId
    try{
      const created=await withTransaction(async db=>{
        await db.query(`UPDATE managed_public_signup_requests SET status='expired',updated_at=now()
          WHERE tenant_slug=$1 AND status='awaiting_email' AND verification_expires_at<=now()`,[requested.slug])
        const result=await db.query(`INSERT INTO managed_public_signup_requests
          (tenant_slug,company_name,owner_name,owner_email,modules,verification_hash,verification_expires_at)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,now()+interval '24 hours')
          RETURNING id`,[requested.slug,requested.companyName,requested.ownerName,
          requested.ownerEmail,JSON.stringify(requested.modules),tokenHash])
        const id=result.rows[0].id
        await db.query(`INSERT INTO managed_public_signup_audit(request_id,action,actor_label)
          VALUES($1,'requested','public-signup')`,[id])
        return id
      })
      requestId=created
    }catch(e){
      if(e?.code==='23505')return c.json({error:'This customer URL already has a pending request.'},409)
      throw e
    }
    try{
      await sendManagedSignupRequestVerificationEmail({
        email:requested.ownerEmail,name:requested.ownerName,companyName:requested.companyName,token,
      })
    }catch{
      await withTransaction(async db=>{
        await db.query("UPDATE managed_public_signup_requests SET status='delivery_failed',updated_at=now() WHERE id=$1 AND status='awaiting_email'",[requestId])
        await db.query("INSERT INTO managed_public_signup_audit(request_id,action,actor_label) VALUES($1,'delivery_failed','smtp-delivery')",[requestId])
      })
      return c.json({error:'Verification email could not be delivered. Please contact support.'},503)
    }
    return c.json({status:'awaiting_email',verificationRequired:true,
      productionActivated:false,updateChoicePending:true,
      message:'Check your inbox to verify your email. Your workspace is not active yet.'},202)
  })
  app.get('/api/v1/public/signup-requests/verify',async(c)=>{
    if(!restricted())return c.json({error:'Unavailable.'},404)
    const token=String(c.req.query('token')||'')
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))
      return c.redirect(publicOrigin+'/signup?verification=invalid',302)
    const found=await withTransaction(async db=>{
      const rows=await db.query(`SELECT id,status FROM managed_public_signup_requests
        WHERE verification_hash=$1 AND verification_expires_at>now() FOR UPDATE`,[hash(token)])
      if(rows.rowCount!==1||rows.rows[0].status!=='awaiting_email')return false
      const id=rows.rows[0].id
      await db.query("UPDATE managed_public_signup_requests SET status='verified',verified_at=now(),updated_at=now() WHERE id=$1",[id])
      await db.query("INSERT INTO managed_public_signup_audit(request_id,action,actor_label) VALUES($1,'verified','email-link')",[id])
      return true
    })
    return c.redirect(publicOrigin+'/signup?verification='+(found?'received':'invalid'),302)
  })
}
