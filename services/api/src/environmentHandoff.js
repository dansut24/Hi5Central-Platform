import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pool, withTransaction } from './db.js'
import { deployment, originMatchesTenant, originMatchesPortalTenant } from './deploymentConfig.js'
import { createSession, resolveSession, setSessionCookie } from './session.js'
import { permittedTenantEnvironment } from './tenantEnvironmentAccess.js'
import { establishEnvironmentSession } from './environmentDirectSession.js'

const digest = token => createHash('sha256').update(String(token)).digest('hex')
const usableSecret = () => String(process.env.ENV_IDENTITY_SHARED_SECRET_FILE
  ? readFileSync(process.env.ENV_IDENTITY_SHARED_SECRET_FILE,'utf8').trim()
  : process.env.ENV_IDENTITY_SHARED_SECRET || '')
function authorised(request) {
  const configured = usableSecret()
  const supplied = String(request.req.header('authorization') || '').replace(/^Bearer\s+/i,'')
  if (configured.length < 32 || supplied.length !== configured.length) return false
  return timingSafeEqual(Buffer.from(configured), Buffer.from(supplied))
}
function safeJson(c, message, code) { return c.json({ error: message }, code) }

export function registerEnvironmentHandoffRoutes(app) {
  // Any active workspace member with a centrally granted Test/UAT entitlement
  // may authenticate there. Platform Admin is NOT required to use an
  // environment; only organisation owners/admins can change grants.
  app.post('/api/v1/auth/environment-access',async c=>{
    if(deployment.runtimeEnvironment!=='live')return safeJson(c,'Use your Live tenant to sign in.',403)
    const session=await resolveSession(c)
    if(!session)return safeJson(c,'Authentication required.',401)
    if(!originMatchesTenant(c.req.header('origin'),session.slug))
      return safeJson(c,'Tenant session mismatch.',403)
    let body
    try {body=await c.req.json()}catch{return safeJson(c,'Invalid access request.',400)}
    const environment=String(body?.environment||'')
    if(!['test','uat'].includes(environment))return safeJson(c,'Unknown environment.',400)
    const surface=body?.surface === 'portal' ? 'portal' : 'workspace'
    if(surface === 'portal' && (!originMatchesPortalTenant(c.req.header('origin'),c.req.header('referer'),session.slug)
      || !session.access?.portalAccess))return safeJson(c,'Requester Portal access required.',403)
    try{
      const access=await establishEnvironmentSession(c,session,environment,{surface})
      return c.json(access)
    }catch(error){
      return safeJson(c,error.message||'Environment access has not been granted.',403)
    }
  })


  // Only the central Live API can redeem tickets, and only from an
  // environment API bearing a long random deployment-held shared secret.
  app.post('/api/v1/internal/environment-handoff/redeem', async c => {
    if (deployment.runtimeEnvironment !== 'live' || !authorised(c)) {
      return safeJson(c, 'Unauthorised.', 401)
    }
    let body
    try { body = await c.req.json() } catch { return safeJson(c,'Invalid handoff request.',400) }
    const environment = String(body?.environment || '')
    const ticket = String(body?.ticket || '')
    if (!['test','uat'].includes(environment) || ticket.length < 40 || ticket.length > 180) {
      return safeJson(c,'Invalid handoff request.',400)
    }
    return withTransaction(async client => {
      const result = await client.query(
        `SELECT h.id,h.tenant_id,h.user_id,h.mfa_verified,t.slug
           FROM tenant_environment_handoffs h
           JOIN tenants t ON t.id=h.tenant_id
           JOIN tenant_memberships m ON m.tenant_id=h.tenant_id AND m.user_id=h.user_id
           JOIN tenant_environment_state e ON e.tenant_id=h.tenant_id AND e.environment=h.environment
          WHERE h.token_hash=$1 AND h.environment=$2
            AND h.used_at IS NULL AND h.expires_at>now()
            AND t.status='active' AND m.status='active' AND e.status='ready'
          FOR UPDATE OF h`,
        [digest(ticket),environment],
      )
      if (!result.rowCount) return safeJson(c,'Handoff invalid or expired.',401)
      const item = result.rows[0]
      if(!await permittedTenantEnvironment(item.tenant_id,item.user_id,environment,{db:client})){
        return safeJson(c,'Environment access has not been granted.',403)
      }
      await client.query('UPDATE tenant_environment_handoffs SET used_at=now() WHERE id=$1',[item.id])
      return c.json({
        tenantId:item.tenant_id,
        tenantSlug:`${item.slug}-${environment}`,
        userId:item.user_id,
        mfaVerified:item.mfa_verified,
      })
    })
  })

  // Environment services accept handoffs only from the original Live
  // account; no customer password or hash is replicated into sandboxes.
  app.post('/api/v1/auth/environment-handoff', async c => {
    const environment = deployment.runtimeEnvironment
    if (!['test','uat'].includes(environment)) return safeJson(c,'Not an environment login endpoint.',404)
    let body
    try { body = await c.req.json() } catch { return safeJson(c,'Invalid environment ticket.',400) }
    const ticket = String(body?.ticket || '')
    if (ticket.length < 40 || ticket.length > 180) return safeJson(c,'Invalid environment ticket.',400)
    const secret = usableSecret()
    const base = String(process.env.ENV_IDENTITY_API_URL || '').replace(/\/$/,'')
    if (secret.length < 32 || !/^https:\/\//.test(base)) {
      return safeJson(c,'Environment authentication is not configured.',503)
    }
    let credential
    try {
      const response = await fetch(`${base}/api/v1/internal/environment-handoff/redeem`, {
        method:'POST',
        headers:{'content-type':'application/json','authorization':`Bearer ${secret}`},
        body:JSON.stringify({ticket,environment}),
        signal:AbortSignal.timeout(6000),
      })
      if (!response.ok) return safeJson(c,'Environment link expired. Open it again from Release Management.',401)
      credential = await response.json()
    } catch (error) {
      console.error('Environment identity authority unavailable', { code:error.code || 'UNAVAILABLE' })
      return safeJson(c,'The identity service is unavailable.',503)
    }
    if (!credential?.tenantId || !credential?.userId
      || !originMatchesTenant(c.req.header('origin'),credential.tenantSlug)) {
      return safeJson(c,'Environment origin mismatch.',403)
    }
    const identity = await pool.query(
      `SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=$1 AND m.user_id=$2 AND t.slug=$3
          AND t.status='active' AND m.status='active'`,
      [credential.tenantId,credential.userId,credential.tenantSlug],
    )
    if (!identity.rowCount) return safeJson(c,'Environment access is not provisioned.',403)
    try {
      const sessionToken = await withTransaction(client => createSession(client,{
        tenantId:credential.tenantId,userId:credential.userId,
        mfaVerified:credential.mfaVerified === true,
        surface:'workspace',
      }))
      setSessionCookie(c,sessionToken)
      return c.json({authenticated:true,tenantSlug:credential.tenantSlug})
    } catch (error) {
      console.error('Environment session issue failed',{code:error.code || 'UNKNOWN'})
      return safeJson(c,'Environment authentication could not be completed.',403)
    }
  })
}

export async function issueEnvironmentTicket(tenantId,userId,environment,{source=pool,verified=false}={}) {
  if (deployment.runtimeEnvironment !== 'live') throw Error('Environment links are issued from Live.')
  if (!['test','uat'].includes(environment)) throw Error('Unknown environment')
  const item = await source.query(
    `SELECT t.slug FROM tenants t JOIN tenant_environment_state e ON e.tenant_id=t.id
      WHERE t.id=$1 AND e.environment=$2 AND e.status='ready'`,
    [tenantId,environment],
  )
  if (!item.rowCount) throw Error('The environment is not ready.')
  if(!await permittedTenantEnvironment(tenantId,userId,environment,{db:source})) throw Error('Environment access has not been granted. Ask your organisation administrator.')
  const secret = usableSecret()
  if (secret.length < 32) throw Error('Environment authentication is not configured.')
  const ticket=randomBytes(40).toString('base64url')
  await source.query(
    `INSERT INTO tenant_environment_handoffs(tenant_id,user_id,environment,token_hash,mfa_verified,expires_at)
     VALUES($1,$2,$3,$4,$5,now()+interval '2 minutes')`,
    [tenantId,userId,environment,digest(ticket),verified],
  )
  const domain = String(process.env.ROOT_DOMAIN || 'hi5central.com')
  return `https://${item.rows[0].slug}-${environment}.${domain}/#hi5_environment_ticket=${encodeURIComponent(ticket)}`
}
