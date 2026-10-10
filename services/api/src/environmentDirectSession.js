import { readFileSync } from 'node:fs'
import pg from 'pg'
import { setCookie } from 'hono/cookie'
import { pool } from './db.js'
import { deployment } from './deploymentConfig.js'
import { createSession } from './session.js'
import { permittedTenantEnvironment } from './tenantEnvironmentAccess.js'

const { Client } = pg

export function environmentSessionCookieName(environment) {
  if (!['test', 'uat'].includes(environment)) throw Error('Unknown environment')
  return `hi5central_${environment}_session`
}

/**
 * The Live identity authority issues an isolated sandbox session directly
 * into the already-provisioned environment database.
 *
 * Unlike a browser-side ticket exchange, the first-party Live API can set an
 * HttpOnly cookie for all *.hi5central.com subdomains. The user never sees
 * a secret token or needs a second cross-origin API request on Safari.
 */
export async function establishEnvironmentSession(c, liveSession, environment, {
  source = pool,
  targets = {},
} = {}) {
  if (deployment.runtimeEnvironment !== 'live') throw Error('Use your Live organisation to authenticate.')
  const cookieName = environmentSessionCookieName(environment)
  const {tenant_id:tenantId,user_id:userId,slug} = liveSession
  if (!await permittedTenantEnvironment(tenantId,userId,environment,{db:source})) {
    const error = Error('Access to this environment has not been granted in People.')
    error.status = 403
    throw error
  }
  const envFile = process.env[`TENANT_${environment.toUpperCase()}_DATABASE_URL_FILE`]
  const connectionString = targets[environment]
    || (envFile ? readFileSync(envFile,'utf8').trim() : process.env[`TENANT_${environment.toUpperCase()}_DATABASE_URL`])
  if (!connectionString) throw Error('Environment session service is unavailable.')
  const client = new Client({connectionString,connectionTimeoutMillis:6000})
  const targetSlug = `${slug}-${environment}`
  let token
  try {
    await client.connect()
    await client.query('BEGIN')
    const member=await client.query(
      `SELECT m.status,t.slug,t.status AS tenant_status
       FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id
       WHERE m.tenant_id=$1 AND m.user_id=$2 FOR UPDATE OF m`,
      [tenantId,userId],
    )
    if (member.rows[0]?.slug!==targetSlug || member.rows[0]?.status!=='active'
      || member.rows[0]?.tenant_status!=='active') {
      const error=Error('Your UAT/Test account is not provisioned. Ask your administrator.')
      error.status=403
      throw error
    }
    token=await createSession(client,{
      tenantId,userId,
      mfaVerified: Boolean(liveSession.mfa_verified_at),
      surface:'workspace',
    })
    await client.query('COMMIT')
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{})
    throw error
  } finally {
    await client.end().catch(()=>{})
  }
  // The Live API origin is a sibling of the UAT/Test API. It is allowed to
  // set a parent-domain cookie (but not to read this HttpOnly credential).
  // Each environment has a different cookie name, so Live stays signed in.
  const domain=String(deployment.rootDomain || process.env.ROOT_DOMAIN || 'hi5central.com')
  setCookie(c,cookieName,token,{
    domain:`.${domain}`,path:'/',httpOnly:true,secure:true,sameSite:'Lax',
    maxAge:60*60*12,
  })
  const url=`https://${targetSlug}.${domain}/dashboard?environment_sso=1`
  return {url,environment,sessionCreated:true}
}
