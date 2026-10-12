import { deployment, originMatchesTenant, portalRequestFromHeaders, originMatchesPortalTenant } from './deploymentConfig.js'
import {pool} from './db.js'
import {sandboxPolicyRequiresMfa} from './securityPolicy.js'

const ALLOWED_FLOWS = Object.freeze({
  login: '/api/v1/auth/login-secure',
  setup: '/api/v1/auth/mfa/setup',
  verify: '/api/v1/auth/mfa/verify',
})
const ENVIRONMENTS = new Set(['test','uat'])

function sandboxTenant(body) {
  const environment = deployment.runtimeEnvironment
  const slug = String(body?.tenantSlug || '').trim().toLowerCase()
  if (!ENVIRONMENTS.has(environment)) return null
  if (!slug.endsWith(`-${environment}`)) return null
  const liveSlug = slug.slice(0, -environment.length - 1)
  if (!/^[a-z0-9][a-z0-9-]{1,41}[a-z0-9]$/.test(liveSlug)
    || liveSlug.includes('--')) return null
  return { liveSlug, sandboxSlug:slug, environment }
}

// Read the target environment's own security policy. This is deliberately
// performed before Live authenticates so a stronger UAT requirement can
// request a Live MFA challenge instead of failing session creation later.
async function requiresSandboxStepUp(sandboxSlug) {
  const result=await pool.query(
    `SELECT ts.configuration,ts.onboarding_data
       FROM tenant_settings ts JOIN tenants t ON t.id=ts.tenant_id
      WHERE t.slug=$1 AND t.status='active' LIMIT 1`,[sandboxSlug])
  if(result.rowCount!==1)throw Error('Sandbox security policy is unavailable.')
  return sandboxPolicyRequiresMfa(result.rows[0])
}

function liveEndpoint() {
  const base = String(process.env.ENV_IDENTITY_API_URL || '').trim()
  if (!base || !/^https:\/\//i.test(base)) throw Error('The central identity service is not configured.')
  const url = new URL(base)
  if (url.pathname !== '/' || url.search || url.hash || url.hostname !== `api.${deployment.rootDomain}`) {
    throw Error('The central identity endpoint is invalid.')
  }
  return url.origin
}

async function sendLive(path, body, liveOrigin, extraHeaders = {}) {
  const response = await fetch(liveEndpoint() + path, {
    method:'POST',
    headers:{
      'content-type':'application/json',
      origin:liveOrigin,
      ...extraHeaders,
    },
    body:JSON.stringify(body),
    redirect:'manual',
    signal:AbortSignal.timeout(12000),
  })
  return {
    status:response.status,
    cookie:response.headers.get('set-cookie') || '',
    payload:await response.json().catch(() => ({error:'Identity server sent an invalid response.'})),
  }
}

function loginCookie(header, surface = 'workspace') {
  const name = surface === 'portal' ? 'hi5central_portal_session' : 'hi5central_session'
  return String(header || '').match(new RegExp(`(?:^|[,;]\\s*)(${name})=([^; ,]+)`, 'i'))
}

export function trustedSandboxLoginOrigin(origin,sandboxSlug) {
  return originMatchesTenant(origin,sandboxSlug)
}

/**
 * This is called by the existing UAT/Test /login-secure and /mfa routes.
 * Credentials and MFA codes go sandbox API -> Live API, never to sandbox DB.
 * The short-lived Live session cookie is used only on the server side to ask
 * the Live identity authority to issue a scoped environment session cookie.
 */
export async function sandboxCredentialLogin(c, flow, body, boundSlug = null) {
  if (!ENVIRONMENTS.has(deployment.runtimeEnvironment)) {
    return c.json({error:'The environment login service is unavailable.'},404)
  }
  if (!Object.hasOwn(ALLOWED_FLOWS,flow)) {
    return c.json({error:'Unknown authentication step.'},400)
  }
  let tenant
  if (flow === 'login') {
    tenant = sandboxTenant(body)
    if (!tenant) return c.json({error:'A valid environment account is required.'},400)
  } else {
    const candidate = String(body?.tenantSlug || boundSlug || '')
    tenant = sandboxTenant({tenantSlug:candidate})
    if (!tenant) return c.json({error:'The environment login must be restarted.'},400)
  }
  const userOrigin = c.req.header('origin') || ''
  const surface=portalRequestFromHeaders(userOrigin,c.req.header('referer') || '') ? 'portal' : 'workspace'
  const allowedOrigin=surface === 'portal'
    ? originMatchesPortalTenant(userOrigin,c.req.header('referer'),tenant.sandboxSlug)
    : trustedSandboxLoginOrigin(userOrigin,tenant.sandboxSlug)
  if (!allowedOrigin) {
    return c.json({error:'Environment sign-in origin mismatch.'},403)
  }
  const liveOrigin = `https://${tenant.liveSlug}${surface === 'portal' ? '-portal' : ''}.${deployment.rootDomain}`

  try {
    const livePayload = flow==='login'
      ? {tenantSlug:tenant.liveSlug,email:body?.email,password:body?.password,
          forceSandboxMfa:await requiresSandboxStepUp(tenant.sandboxSlug)}
      : flow==='setup'
        ? {challengeToken:body?.challengeToken}
        : {challengeToken:body?.challengeToken,code:body?.code}
    const upstream=await sendLive(ALLOWED_FLOWS[flow],livePayload,liveOrigin)
    if(upstream.status !== 200) {
      return c.json({error:upstream.payload.error || 'Sign-in could not be completed.'},
        upstream.status >= 400 && upstream.status < 500 ? upstream.status : 503)
    }
    if(flow==='setup') {
      return c.json(upstream.payload)
    }
    if(!upstream.payload?.authenticated){
      if(flow==='verify')return c.json({error:'Central MFA verification did not complete.'},401)
      return c.json(upstream.payload)
    }
    const liveCookie = loginCookie(upstream.cookie,surface)
    if(!liveCookie) return c.json({error:'Central identity did not issue a valid sign-in session.'},503)

    const access = await sendLive(
      '/api/v1/auth/environment-access',
      {environment:tenant.environment,surface},
      liveOrigin,
      {cookie:`${liveCookie[1]}=${liveCookie[2]}`},
    )
    if(access.status !== 200) {
      return c.json({error:access.payload.error || 'This account is not allowed to access the environment.'},
        access.status>=400 && access.status<500 ? access.status : 503)
    }
    const expectedName = `hi5central_${tenant.environment}_${surface === 'portal' ? 'portal_session' : 'session'}`
    if (!new RegExp(`(?:^|[,;]\\s*)${expectedName}=[^; ,]+`).test(access.cookie)) {
      return c.json({error:'The environment session could not be established.'},503)
    }
    c.header('Set-Cookie',access.cookie)
    return c.json({
      authenticated:true,
      mfaRequired:false,
      environment:tenant.environment,
      recoveryCodes:flow==='verify' ? upstream.payload.recoveryCodes || null : null,
    })
  } catch(error) {
    console.error('Sandbox central identity exchange failed',{
      environment:tenant.environment,flow,
      code:error.code || error.cause?.code || 'IDENTITY_UNAVAILABLE',
    })
    return c.json({error:'The central identity service is temporarily unavailable.'},503)
  }
}

/** A login challenge must stay bound to its environment between requests. */
export function mfaSandboxSlug(c, body) {
  return String(body?.tenantSlug || c.req.header('x-hi5-environment-tenant') || '').trim().toLowerCase()
}
