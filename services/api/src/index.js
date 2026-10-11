import { createHash, randomBytes, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { attachAccess, effectiveAccessForUser } from './access.js'
import { registerApiTokenRoutes } from './apiTokens.js'
import { registerApplicationUpdatesRoutes } from './applicationUpdates.js'
import { enforceWorkspacePermissions } from './accessGate.js'
import { registerCmdbRoutes } from './cmdb.js'
import { registerKnowledgeRoutes } from './knowledge.js'
import { registerCatalogueRoutes } from './catalogue.js'
import { featureEntitled, registerLicensingRoutes, startLicensingRefreshScheduler } from './licensing.js'
import { registerFeatureFlagRoutes } from './featureFlags.js'
import { persistOnboardingUpdatePreference, registerTenantReleaseRoutes } from './tenantRelease.js'
import { registerTenantFeatureRoutes } from './tenantFeatureRollouts.js'
import { backfillCompletedTenantSandboxes, provisionTenantSandboxes } from './tenantEnvironmentProvisioner.js'
import { registerEnvironmentHandoffRoutes } from './environmentHandoff.js'
import { registerTenantEnvironmentAccessRoutes } from './tenantEnvironmentAccess.js'
import { markTenantSmtpVerified, readTenantDeliverySettings, safeTenantDeliverySettings, saveTenantDeliverySettings, verifyTenantDomain, verifyTenantSmtp } from './tenantDelivery.js'
import { registerLicenseAuthorityRoutes } from './licenseAuthority.js'
import { registerMicrosoftRoutes, startMicrosoftSyncScheduler } from './microsoftIntegration.js'
import { registerMfaRoutes } from './mfa.js'
import { attachRmmAgentWebSocket, initializeAgentBroker, registerRmmAgentRoutes, shutdownAgentBroker } from './rmmAgent.js'
import { registerRmmAutomationRoutes } from './rmmAutomation.js'
import { registerRmmActivityRoutes } from './rmmActivity.js'
import { attachRmmDeviceToolWebSocket, registerRmmDeviceToolRoutes } from './rmmDeviceTools.js'
import { attachRmmViewerWebSocket, registerRmmRemoteRoutes } from './rmmRemote.js'
import { attachRmmConnectWebSockets, registerRmmConnectRoutes } from './rmmConnect.js'
import { registerRmmScopeRoutes } from './rmmScope.js'
import { registerRmmPatchingRoutes } from './rmmPatching.js'
import { registerRmmAppPortalRoutes } from './rmmAppPortal.js'
import { registerRmmNetworkDiscoveryRoutes, startRmmNetworkDiscoveryScheduler } from './rmmNetworkDiscovery.js'
import { startRmmMacOuiScheduler } from './rmmMacOui.js'
import { registerRmmRecoveryKeyRoutes } from './rmmRecoveryKeys.js'
import { startRmmVulnerabilitySyncScheduler } from './rmmVulnerabilityIntel.js'
import { startSoftwareVendorSyncScheduler } from './rmmSoftwareVendorIntel.js'
import { startTenantVendorSourceScheduler } from './rmmTenantVendorSources.js'
import {
  allowedRequestOrigin,
  deployment,
  originMatchesTenant,
  tenantUrls,
} from './deploymentConfig.js'
import { pool, withTransaction } from './db.js'
import { sendVerificationEmail, verifySmtpConnection } from './mailer.js'
import { registerOrganisationRoutes } from './organisation.js'
import { buildOpenApiDocument } from './openapi.js'
import { registerPlatformAdminRoutes } from './platformAdmin.js'
import { registerReleaseOperatorRoutes } from './releaseOperator.js'
import { registerReleaseFeedRoutes, startReleaseFeedScheduler } from './releaseFeed.js'
import { registerProjectRoutes } from './projects.js'
import { verifyPassword } from './password.js'
import { validExistingTenantSlug, validNewTenantSlug } from './tenantSlugPolicy.js'
import { ensureRedisConnected, redis } from './redis.js'
import { registerSettingsRoutes } from './settings.js'
import { registerUserPreferenceRoutes } from './userPreferences.js'
import { registerSecurityRoutes } from './security.js'
import {
  createSession,
  resolveOnboardingSession,
  resolveSession,
  revokeCurrentSession,
  sessionPayload,
  setSessionCookie,
} from './session.js'

console.log('[API] Module imports loaded; registering routes...')

const scryptAsync = promisify(scrypt)
const app = new Hono()
const port = Number(process.env.PORT || 3001)
const backgroundWorkersEnabled = !['0', 'false', 'off', 'no'].includes(String(process.env.BACKGROUND_WORKERS_ENABLED || 'true').trim().toLowerCase())
const marketingUrl = deployment.marketingUrl || deployment.appUrl || `https://${deployment.rootDomain}`

const reservedSlugs = new Set([
  'admin', 'api', 'app', 'auth', 'connect', 'downloads', 'help', 'login', 'mail', 'portal',
  'reseller', 'rmm', 'signup', 'smtp', 'status', 'support', 'turn', 'www',
])

function normaliseEmail(value = '') { return String(value).trim().toLowerCase() }
function normaliseSlug(value = '') { return String(value).trim().toLowerCase() }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 }

async function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`
}
function hashToken(token) { return createHash('sha256').update(token).digest('hex') }
function requestIp(c) {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return c.req.header('x-real-ip') || 'unknown'
}
function allowedOrigin(origin) { return allowedRequestOrigin(origin) }
function originMatchesSession(c, session) { return originMatchesTenant(c.req.header('origin'), session.slug) }
function onboardingSequence(modules = {}) {
  return [
    'company',
    'theme',
    'delivery',
    'groups',
    'permissions',
    'security',
    'updates',
    modules?.itsm ? 'itsm' : null,
    modules?.rmm ? 'rmm' : null,
    'finish',
  ].filter(Boolean)
}
async function rateLimit(redisClient, key, max, seconds) {
  const attempts = await redisClient.incr(key)
  if (attempts === 1) await redisClient.expire(key, seconds)
  return attempts <= max
}

async function recordVerificationDelivery(tokenHash, result) {
  if (result.ok) {
    await pool.query('UPDATE user_email_verifications SET sent_at=now(),send_attempts=send_attempts+1,last_send_error=NULL WHERE token_hash=$1', [tokenHash])
    return
  }
  await pool.query(
    'UPDATE user_email_verifications SET send_attempts=send_attempts+1,last_send_error=$2 WHERE token_hash=$1',
    [tokenHash, String(result.error?.message || result.error || 'Unknown SMTP error').slice(0, 1000)],
  )
}

async function deliverVerification({ token, email, name, companyName, tenantUrl }) {
  const tokenHash = hashToken(token)
  try {
    const info = await sendVerificationEmail({ to: email, name, companyName, token, tenantUrl })
    await recordVerificationDelivery(tokenHash, { ok: true })
    return { status: 'sent', messageId: info?.messageId || null }
  } catch (error) {
    console.error('Verification email delivery failed', error)
    await recordVerificationDelivery(tokenHash, { ok: false, error })
    return { status: 'failed' }
  }
}

app.use('*', secureHeaders())
app.use('/api/*', cors({
  origin: allowedOrigin,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Hi5-Filename'],
  credentials: true,
  maxAge: 600,
}))
app.use('/api/v1/*', enforceWorkspacePermissions)

app.get('/live', (c) => c.json({ status: 'ok', service: 'hi5central-api' }))
app.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1')
    const redisClient = await ensureRedisConnected()
    await redisClient.ping()
    return c.json({ status: 'ok', postgres: 'ok', redis: 'ok' })
  } catch (error) {
    console.error('Health check failed', error)
    return c.json({ status: 'error' }, 503)
  }
})

app.get('/api/v1/system/deployment', (c) => c.json({
  deploymentMode: deployment.deploymentMode,
  tenancyMode: deployment.tenancyMode,
  rootDomain: deployment.rootDomain,
  primaryTenantSlug: deployment.primaryTenantSlug,
  appUrl: deployment.appUrl,
  apiUrl: deployment.apiUrl,
  portalUrl: deployment.portalUrl,
  rmmUrl: deployment.rmmUrl,
  adminUrl: deployment.adminUrl,
  backgroundWorkersEnabled,
}))

app.get('/api/v1/system/smtp-health', async (c) => {
  try {
    await verifySmtpConnection()
    return c.json({ status: 'ok', smtp: 'ok' })
  } catch (error) {
    console.error('SMTP health check failed', error)
    return c.json({ status: 'error', smtp: 'error' }, 503)
  }
})

app.get('/api/v1/system/capabilities', (c) => c.json({
  api: { framework: 'Hono', version: 'v1', apiFirst: true },
  authentication: {
    browser: 'session_cookie',
    integrations: 'bearer_api_token',
    apiTokenEndpoint: '/api/v1/integrations/api-tokens',
  },
  documentation: {
    openapi: '/api/v1/openapi.json',
    routes: '/api/v1/system/routes',
  },
  deployment: {
    mode: deployment.deploymentMode,
    edition: deployment.selfHostEdition,
    tenancy: deployment.tenancyMode,
  },
}))

app.get('/api/v1/auth/tenant-slug/:slug', async (c) => {
  const slug = normaliseSlug(c.req.param('slug'))
  if (!validNewTenantSlug(slug, reservedSlugs)) return c.json({ slug, available: false, reason: 'invalid' }, 200)
  if (deployment.tenancyMode === 'single' && slug !== deployment.primaryTenantSlug) return c.json({ slug, available: false, reason: 'single_tenant' }, 200)
  const result = await pool.query('SELECT 1 FROM tenants WHERE slug=$1 LIMIT 1', [slug])
  return c.json({ slug, available: result.rowCount === 0 })
})

app.get('/api/v1/auth/tenant-state/:slug', async (c) => {
  const slug = normaliseSlug(c.req.param('slug'))
  if (!validExistingTenantSlug(slug)) return c.json({ managed: false, slug }, 200)
  const result = await pool.query('SELECT t.slug,t.company_name,t.status FROM tenants t WHERE t.slug=$1 LIMIT 1', [slug])
  if (!result.rowCount) {
    const setupRequired = deployment.deploymentMode === 'self_hosted'
      && deployment.tenancyMode === 'single'
      && slug === deployment.primaryTenantSlug
    return c.json({ managed: false, slug, setupRequired })
  }
  const tenant = result.rows[0]
  return c.json({ managed: true, slug: tenant.slug, companyName: tenant.company_name, status: tenant.status })
})

app.post('/api/v1/auth/login', async (c) => {
  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }
  const tenantSlug = normaliseSlug(body?.tenantSlug || (deployment.tenancyMode === 'single' ? deployment.primaryTenantSlug : ''))
  const email = normaliseEmail(body?.email)
  const password = String(body?.password || '')
  if (!validExistingTenantSlug(tenantSlug) || !validEmail(email) || !password) return c.json({ error: 'Enter a valid email address and password.' }, 400)

  const origin = c.req.header('origin')
  if (process.env.NODE_ENV === 'production' && origin && !originMatchesTenant(origin, tenantSlug)) return c.json({ error: 'Tenant sign-in origin mismatch.' }, 403)
  const redisClient = await ensureRedisConnected()
  const allowed = await rateLimit(redisClient, `login:${requestIp(c)}:${tenantSlug}:${email}`, 10, 900)
  if (!allowed) return c.json({ error: 'Too many sign-in attempts. Please try again later.' }, 429)

  const result = await pool.query(
    `SELECT t.id AS tenant_id,t.slug,t.company_name,t.status AS tenant_status,
            u.id AS user_id,u.email,u.name,u.password_hash,
            m.role AS tenant_role,m.status AS membership_status,
            ts.modules,ts.onboarding_step,ts.onboarding_completed_at,ts.onboarding_data,ts.configuration,
            ts.tenant_url,ts.portal_url,ts.rmm_url
     FROM tenants t
     JOIN tenant_memberships m ON m.tenant_id=t.id
     JOIN users u ON u.id=m.user_id
     JOIN tenant_settings ts ON ts.tenant_id=t.id
     WHERE t.slug=$1 AND u.email=$2 LIMIT 1`,
    [tenantSlug, email],
  )
  if (!result.rowCount) return c.json({ error: 'Email address or password is incorrect.' }, 401)
  const account = result.rows[0]
  if (account.tenant_status === 'pending_verification' || account.membership_status === 'pending_verification') return c.json({ error: 'Verify your email address before signing in.' }, 403)
  if (account.tenant_status !== 'active' || account.membership_status !== 'active') return c.json({ error: 'This Hi5Central account is not currently active.' }, 403)
  const valid = await verifyPassword(password, account.password_hash)
  if (!valid) return c.json({ error: 'Email address or password is incorrect.' }, 401)

  const access = await effectiveAccessForUser(pool, account.tenant_id, account.user_id, account.tenant_role)
  if (!access.workspaceAccess) return c.json({ error: 'Your Hi5Central roles do not include access to this workspace. Use the requester portal instead.' }, 403)
  const resolvedAccount = attachAccess(account, access, 'workspace')
  const token = await withTransaction((client) => createSession(client, { tenantId: account.tenant_id, userId: account.user_id, surface: 'workspace' }))
  setSessionCookie(c, token)
  return c.json(sessionPayload(resolvedAccount))
})

app.post('/api/v1/auth/signup', async (c) => {
  const redisClient = await ensureRedisConnected()
  const allowed = await rateLimit(redisClient, `signup:${requestIp(c)}:${Math.floor(Date.now() / 60000)}`, 5, 60)
  if (!allowed) return c.json({ error: 'Too many signup attempts. Please try again shortly.' }, 429)
  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }

  const companyName = String(body?.companyName || '').trim()
  const tenantSlug = normaliseSlug(body?.tenantSlug || (deployment.tenancyMode === 'single' ? deployment.primaryTenantSlug : ''))
  const name = String(body?.name || '').trim()
  const email = normaliseEmail(body?.email)
  const password = String(body?.password || '')
  const requestedModules = Array.isArray(body?.modules) ? body.modules.map(String) : ['itsm']
  const modules = [...new Set(requestedModules.filter((item) => ['itsm','rmm'].includes(item)))]
  if (companyName.length < 2 || companyName.length > 120) return c.json({ error: 'Company name must be between 2 and 120 characters.' }, 400)
  if (!validNewTenantSlug(tenantSlug, reservedSlugs)) return c.json({ error: 'Choose a valid tenant URL using lowercase letters, numbers or hyphens, without reserved environment suffixes.' }, 400)
  if (deployment.tenancyMode === 'single' && tenantSlug !== deployment.primaryTenantSlug) return c.json({ error: `This installation is assigned to tenant ${deployment.primaryTenantSlug}.`, field: 'tenantSlug' }, 400)
  if (name.length < 2 || name.length > 120) return c.json({ error: 'Your name must be between 2 and 120 characters.' }, 400)
  if (!validEmail(email)) return c.json({ error: 'Enter a valid email address.' }, 400)
  if (password.length < 12 || password.length > 256) return c.json({ error: 'Use a password or passphrase of at least 12 characters.' }, 400)
  if (!modules.length) return c.json({ error: 'Select at least one Hi5Central product.' }, 400)

  const [slugExists, emailExists, tenantCount] = await Promise.all([
    pool.query('SELECT 1 FROM tenants WHERE slug=$1 LIMIT 1', [tenantSlug]),
    pool.query('SELECT id,password_hash FROM users WHERE email=$1 LIMIT 1', [email]),
    deployment.tenancyMode === 'single' ? pool.query('SELECT count(*)::int AS count FROM tenants') : Promise.resolve({ rows: [{ count: 0 }] }),
  ])
  const tenantCountValue = Number(tenantCount.rows[0]?.count || 0)
  const firstSelfHostSetup = deployment.deploymentMode === 'self_hosted'
    && deployment.tenancyMode === 'single'
    && tenantCountValue === 0

  if (deployment.tenancyMode === 'single' && tenantCountValue > 0) return c.json({ error: 'This single-tenant installation has already been initialised.' }, 409)

  if (firstSelfHostSetup) {
    const suppliedSetupToken = String(body?.setupToken || '').trim()
    const expectedSetupToken = String(process.env.INITIAL_SETUP_TOKEN || '').trim()
    if (!expectedSetupToken || !suppliedSetupToken || hashToken(suppliedSetupToken) !== hashToken(expectedSetupToken)) {
      return c.json({ error: 'The initial setup code is missing or invalid.' }, 403)
    }
  }

  if (slugExists.rowCount) return c.json({ error: 'That tenant URL is already in use.', field: 'tenantSlug' }, 409)
  if (emailExists.rowCount && !await verifyPassword(password, emailExists.rows[0].password_hash)) return c.json({ error: 'Email address or password is incorrect.' }, 401)

  // Existing email addresses reuse the same identity/password across tenant memberships.
  const passwordHash = emailExists.rowCount ? null : await hashPassword(password)
  const verificationToken = firstSelfHostSetup ? '' : randomBytes(32).toString('base64url')
  const verificationTokenHash = verificationToken ? hashToken(verificationToken) : ''
  const generatedUrls = tenantUrls(tenantSlug, { rmm: modules.includes('rmm') })
  const { tenantUrl, rmmUrl } = generatedUrls
  const portalUrl = modules.includes('itsm') ? generatedUrls.portalUrl : null
  const moduleConfiguration = JSON.stringify({
    itsm: modules.includes('itsm'),
    selfService: modules.includes('itsm'),
    rmm: modules.includes('rmm'),
  })

  try {
    const result = await withTransaction(async (client) => {
      if (firstSelfHostSetup) {
        const tenantResult = await client.query(
          "INSERT INTO tenants (slug,company_name,status) VALUES ($1,$2,'active') RETURNING id,slug,company_name,status",
          [tenantSlug, companyName],
        )
        const tenant = tenantResult.rows[0]
        const userResult = await client.query(
          'INSERT INTO users (email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id,email,name',
          [email, name, passwordHash],
        )
        const user = userResult.rows[0]
        await client.query(
          "INSERT INTO tenant_memberships (tenant_id,user_id,role,status) VALUES ($1,$2,'owner','active')",
          [tenant.id, user.id],
        )
        await client.query(
          `INSERT INTO tenant_settings (tenant_id,modules,onboarding_step,tenant_url,portal_url,rmm_url)
           VALUES ($1,$2::jsonb,'company',$3,$4,$5)`,
          [tenant.id, moduleConfiguration, tenantUrl, portalUrl, rmmUrl],
        )
        const sessionToken = await createSession(client, { tenantId: tenant.id, userId: user.id, surface: 'workspace' })
        return { tenant, user, sessionToken }
      }

      const tenantResult = await client.query('INSERT INTO tenants (slug,company_name) VALUES ($1,$2) RETURNING id,slug,company_name,status', [tenantSlug, companyName])
      const tenant = tenantResult.rows[0]
      let user
      if (emailExists.rowCount) {
        // Lock the identity during membership creation; never reset its password,
        // overwrite its name, or grant access to any other tenant.
        const existing = await client.query('SELECT id,email,name,password_hash FROM users WHERE email=$1 FOR UPDATE', [email])
        if (!existing.rowCount || !await verifyPassword(password, existing.rows[0].password_hash)) {
          const error = new Error('Existing account changed during signup.')
          error.code = 'EXISTING_IDENTITY_CHANGED'
          throw error
        }
        user = existing.rows[0]
      } else {
        const userResult = await client.query('INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING id,email,name', [email, name, passwordHash])
        user = userResult.rows[0]
      }
      await client.query("INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'owner')", [tenant.id, user.id])
      await client.query(
        `INSERT INTO tenant_settings (tenant_id,modules,onboarding_step,tenant_url,portal_url,rmm_url)
         VALUES ($1,$2::jsonb,'verify_email',$3,$4,$5)`,
        [tenant.id, moduleConfiguration, tenantUrl, portalUrl, rmmUrl],
      )
      await client.query(
        `INSERT INTO user_email_verifications (tenant_id,user_id,token_hash,redirect_url,expires_at)
         VALUES ($1,$2,$3,$4,now()+interval '24 hours')`,
        [tenant.id, user.id, verificationTokenHash, tenantUrl],
      )
      return { tenant, user }
    })

    if (firstSelfHostSetup) {
      setSessionCookie(c, result.sessionToken)
      return c.json({
        status: 'active',
        verificationRequired: false,
        onboardingStep: 'company',
        tenant: { slug: result.tenant.slug, companyName: result.tenant.company_name, tenantUrl, portalUrl, rmmUrl },
        admin: { name: result.user.name, email: result.user.email },
      }, 201)
    }

    const delivery = await deliverVerification({ token: verificationToken, email: result.user.email, name: result.user.name, companyName: result.tenant.company_name, tenantUrl })
    return c.json({
      status: 'pending_verification', verificationRequired: true, verificationDelivery: delivery.status, onboardingStep: 'verify_email',
      tenant: { slug: result.tenant.slug, companyName: result.tenant.company_name, tenantUrl, portalUrl, rmmUrl },
      admin: { name: result.user.name, email: result.user.email },
    }, 201)
  } catch (error) {
    if (error?.code === 'EXISTING_IDENTITY_CHANGED') return c.json({ error: 'Account details changed while signing up. Please try again.' }, 409)
    if (error?.code === '23505') return c.json({ error: 'That tenant URL or email address is already registered.' }, 409)
    throw error
  }
})

app.post('/api/v1/auth/resend-verification', async (c) => {
  const redisClient = await ensureRedisConnected()
  const allowed = await rateLimit(redisClient, `verify-resend:${requestIp(c)}`, 3, 900)
  if (!allowed) return c.json({ error: 'Too many verification requests. Please try again later.' }, 429)
  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }
  const email = normaliseEmail(body?.email)
  const tenantSlug = normaliseSlug(body?.tenantSlug || (deployment.tenancyMode === 'single' ? deployment.primaryTenantSlug : ''))
  if (!validEmail(email) || !validNewTenantSlug(tenantSlug, reservedSlugs)) return c.json({ status: 'accepted' }, 202)

  const lookup = await pool.query(
    `SELECT t.id AS tenant_id,t.slug,t.company_name,t.status,u.id AS user_id,u.email,u.name,ts.tenant_url
     FROM tenants t
     JOIN tenant_memberships m ON m.tenant_id=t.id AND m.role='owner'
     JOIN users u ON u.id=m.user_id
     JOIN tenant_settings ts ON ts.tenant_id=t.id
     WHERE t.slug=$1 AND u.email=$2 LIMIT 1`,
    [tenantSlug, email],
  )
  if (!lookup.rowCount || lookup.rows[0].status !== 'pending_verification') return c.json({ status: 'accepted' }, 202)
  const account = lookup.rows[0]
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  await withTransaction(async (client) => {
    await client.query('UPDATE user_email_verifications SET used_at=COALESCE(used_at,now()) WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL', [account.tenant_id, account.user_id])
    await client.query("INSERT INTO user_email_verifications (tenant_id,user_id,token_hash,redirect_url,expires_at) VALUES ($1,$2,$3,$4,now()+interval '24 hours')", [account.tenant_id, account.user_id, tokenHash, account.tenant_url])
  })
  const delivery = await deliverVerification({ token, email: account.email, name: account.name, companyName: account.company_name, tenantUrl: account.tenant_url })
  return c.json({ status: delivery.status === 'sent' ? 'sent' : 'accepted' }, 202)
})

app.get('/api/v1/auth/verify-email', async (c) => {
  const token = String(c.req.query('token') || '')
  if (token.length < 32 || token.length > 256) return c.redirect(`${marketingUrl}/signup?verification=invalid`, 302)
  const tokenHash = hashToken(token)
  const sessionToken = await withTransaction(async (client) => {
    const verificationResult = await client.query(
      `SELECT v.id,v.tenant_id,v.user_id,v.expires_at,v.used_at,t.slug,ts.tenant_url
       FROM user_email_verifications v
       JOIN tenants t ON t.id=v.tenant_id
       JOIN tenant_settings ts ON ts.tenant_id=v.tenant_id
       WHERE v.token_hash=$1 FOR UPDATE`,
      [tokenHash],
    )
    if (!verificationResult.rowCount) return null
    const verification = verificationResult.rows[0]
    if (verification.used_at || new Date(verification.expires_at).getTime() <= Date.now()) return null
    await client.query('UPDATE user_email_verifications SET used_at=now() WHERE id=$1', [verification.id])
    await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$1', [verification.user_id])
    await client.query("UPDATE tenants SET status='active',updated_at=now() WHERE id=$1 AND status='pending_verification'", [verification.tenant_id])
    await client.query("UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2", [verification.tenant_id, verification.user_id])
    await client.query("UPDATE tenant_settings SET onboarding_step=CASE WHEN onboarding_completed_at IS NULL THEN 'company' ELSE onboarding_step END,updated_at=now() WHERE tenant_id=$1", [verification.tenant_id])
    const rawSessionToken = await createSession(client, { tenantId: verification.tenant_id, userId: verification.user_id, surface: 'workspace' })
    return { token: rawSessionToken, tenantUrl: verification.tenant_url }
  })
  if (!sessionToken) return c.redirect(`${marketingUrl}/signup?verification=invalid`, 302)
  setSessionCookie(c, sessionToken.token)
  return c.redirect(`${sessionToken.tenantUrl}/onboarding`, 302)
})

app.get('/api/v1/auth/session', async (c) => {
  const session = await resolveSession(c)
  if (!session) return c.json({ authenticated: false }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)
  return c.json(sessionPayload(session))
})

app.get('/api/v1/onboarding/session', async (c) => {
  const session = await resolveOnboardingSession(c)
  if (!session) return c.json({ authenticated: false }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)
  return c.json(sessionPayload(session))
})

app.post('/api/v1/auth/logout', async (c) => {
  await revokeCurrentSession(c)
  return c.json({ status: 'signed_out' })
})

app.get('/api/v1/onboarding/delivery', async (c) => {
  const session = await resolveOnboardingSession(c)
  if (!session) return c.json({ error: 'Authentication required.' }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)

  const row = await readTenantDeliverySettings(session.tenant_id)
  return c.json({
    config: safeTenantDeliverySettings(row) || {
      domainMode: 'default',
      customWorkspaceDomain: '',
      customPortalDomain: '',
      domainStatus: 'default',
      domainVerificationToken: '',
      smtpMode: 'default',
      smtpHost: '',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      smtpUsername: '',
      smtpPasswordConfigured: false,
      smtpFromName: session.company_name || 'Hi5Central',
      smtpFromEmail: '',
      smtpVerifiedAt: null,
    },
    defaults: {
      deploymentMode: deployment.deploymentMode,
      workspaceUrl: session.tenant_url,
      portalUrl: session.portal_url,
      outboundMail: deployment.deploymentMode === 'managed' ? 'Hi5Central managed mail' : 'Server SMTP configuration',
    },
  })
})

app.post('/api/v1/onboarding/delivery', async (c) => {
  const session = await resolveOnboardingSession(c)
  if (!session) return c.json({ error: 'Authentication required.' }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)

  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }

  try {
    const config = await saveTenantDeliverySettings(session.tenant_id, body || {})
    return c.json({ config })
  } catch (error) {
    return c.json({ error: error?.message || 'Could not save domain and email settings.' }, 400)
  }
})

app.post('/api/v1/onboarding/delivery/verify-domain', async (c) => {
  const session = await resolveOnboardingSession(c)
  if (!session) return c.json({ error: 'Authentication required.' }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)

  try {
    const config = await verifyTenantDomain(session.tenant_id)
    return c.json({ ok: true, config })
  } catch (error) {
    return c.json({ ok: false, error: error?.message || 'Custom domain verification failed.' }, 400)
  }
})

app.post('/api/v1/onboarding/delivery/test-smtp', async (c) => {
  const session = await resolveOnboardingSession(c)
  if (!session) return c.json({ error: 'Authentication required.' }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)

  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }

  try {
    const config = await saveTenantDeliverySettings(session.tenant_id, { ...(body || {}), smtpMode: 'custom' })
    await verifyTenantSmtp(session.tenant_id)
    await markTenantSmtpVerified(session.tenant_id)
    const refreshed = await readTenantDeliverySettings(session.tenant_id)
    return c.json({ ok: true, config: safeTenantDeliverySettings(refreshed) || config })
  } catch (error) {
    return c.json({ ok: false, error: error?.message || 'SMTP connection test failed.' }, 400)
  }
})

app.post('/api/v1/onboarding/save', async (c) => {
  const session = await resolveOnboardingSession(c)
  if (!session) return c.json({ error: 'Authentication required.' }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)
  if (session.onboarding_completed_at) return c.json(sessionPayload(session))

  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }

  const step = String(body?.step || '')
  const data = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {}
  const sequence = onboardingSequence(session.modules || {})
  const currentIndex = sequence.indexOf(session.onboarding_step)
  const stepIndex = sequence.indexOf(step)

  if (currentIndex < 0 || stepIndex < 0 || stepIndex > currentIndex) {
    return c.json({ error: 'That onboarding step cannot be edited yet.' }, 409)
  }
  if (JSON.stringify(data).length > 20_000) return c.json({ error: 'Onboarding data is too large.' }, 413)

  await withTransaction(async (client) => {
    if (step === 'updates') {
      await persistOnboardingUpdatePreference(client, { tenantId: session.tenant_id, userId: session.user_id, data })
    }
    await client.query(
      `UPDATE tenant_settings
       SET onboarding_data=COALESCE(onboarding_data,'{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),
           updated_at=now()
       WHERE tenant_id=$1`,
      [session.tenant_id, step, JSON.stringify(data)],
    )
  })

  const nextSession = {
    ...session,
    onboarding_data: {
      ...(session.onboarding_data || {}),
      [step]: data,
    },
  }
  return c.json(sessionPayload(nextSession))
})

app.post('/api/v1/onboarding/step', async (c) => {
  const session = await resolveOnboardingSession(c)
  if (!session) return c.json({ error: 'Authentication required.' }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)
  if (session.onboarding_completed_at) return c.json(sessionPayload(session))
  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }
  const step = String(body?.step || '')
  const data = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {}
  const sequence = onboardingSequence(session.modules || {})
  const currentIndex = sequence.indexOf(session.onboarding_step)
  if (currentIndex < 0 || step !== session.onboarding_step) return c.json({ error: 'This onboarding step is no longer current. Refresh and continue from the active step.' }, 409)
  const nextStep = sequence[Math.min(currentIndex + 1, sequence.length - 1)]
  if (JSON.stringify(data).length > 20_000) return c.json({ error: 'Onboarding data is too large.' }, 413)
  await withTransaction(async (client) => {
    if (step === 'updates') {
      await persistOnboardingUpdatePreference(client, { tenantId: session.tenant_id, userId: session.user_id, data })
    }
    await client.query(
      `UPDATE tenant_settings SET onboarding_data=COALESCE(onboarding_data,'{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),onboarding_step=$4,updated_at=now() WHERE tenant_id=$1`,
      [session.tenant_id, step, JSON.stringify(data), nextStep],
    )
  })
  const nextSession = {
    ...session,
    onboarding_step: nextStep,
    onboarding_data: {
      ...(session.onboarding_data || {}),
      [step]: data,
    },
  }
  return c.json(sessionPayload(nextSession))
})

app.post('/api/v1/onboarding/complete', async (c) => {
  const session = await resolveOnboardingSession(c)
  if (!session) return c.json({ error: 'Authentication required.' }, 401)
  if (!originMatchesSession(c, session)) return c.json({ error: 'Tenant session mismatch.' }, 403)
  if (session.onboarding_completed_at) return c.json(sessionPayload(session))
  if (session.onboarding_step !== 'finish') return c.json({ error: 'Complete the remaining onboarding steps first.' }, 409)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE tenant_settings
       SET onboarding_step='complete',
           onboarding_completed_at=now(),
           configuration=CASE WHEN configuration='{}'::jsonb THEN onboarding_data ELSE configuration END,
           updated_at=now()
       WHERE tenant_id=$1`,
      [session.tenant_id],
    )
    await client.query(
      `INSERT INTO user_experience_preferences (
         user_id,preferences,first_login_completed_at,platform_guidance,platform_getting_started,updated_at
       ) VALUES ($1,'{}'::jsonb,NULL,'{}'::jsonb,'{}'::jsonb,now())
       ON CONFLICT (user_id) DO NOTHING`,
      [session.user_id],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  const refreshed = await resolveSession(c)
  const environments = await provisionTenantSandboxes(session.tenant_id)
    .catch(error => {
      console.error('Onboarding environment setup failed', {tenantId:session.tenant_id, code:error.code || 'UNKNOWN'})
      return { test:{status:'error'}, uat:{status:'error'} }
    })
  return c.json({ ...sessionPayload(refreshed), environments })
})

app.use('/api/platform/v1/*', async (c, next) => {
  if (deployment.deploymentMode === 'managed') return next()
  if (deployment.selfHostEdition === 'standard') {
    if (deployment.runtimeEnvironment === 'live' && c.req.path.startsWith('/api/platform/v1/releases')) return next()
    return c.json({ error: 'Platform Admin is not included in the Standard self-host edition.', code: 'FEATURE_NOT_AVAILABLE' }, 404)
  }
  if (!await featureEntitled('platformAdmin')) {
    return c.json({ error: 'A valid Hi5Central MSP licence is required.', code: 'FEATURE_NOT_ENTITLED' }, 403)
  }
  return next()
})

registerPlatformAdminRoutes(app)
registerReleaseOperatorRoutes(app)
registerReleaseFeedRoutes(app)
registerLicenseAuthorityRoutes(app)
registerLicensingRoutes(app)
registerFeatureFlagRoutes(app)
registerTenantReleaseRoutes(app)
registerApplicationUpdatesRoutes(app)
registerTenantFeatureRoutes(app)
registerEnvironmentHandoffRoutes(app)
registerTenantEnvironmentAccessRoutes(app)
registerApiTokenRoutes(app)
registerCatalogueRoutes(app)
registerCmdbRoutes(app)
registerKnowledgeRoutes(app)
registerOrganisationRoutes(app)
registerSettingsRoutes(app)
registerUserPreferenceRoutes(app)
registerSecurityRoutes(app)
registerMfaRoutes(app)
registerProjectRoutes(app)
registerMicrosoftRoutes(app)
registerRmmAgentRoutes(app)
registerRmmAutomationRoutes(app)
registerRmmActivityRoutes(app)
registerRmmDeviceToolRoutes(app)
registerRmmRemoteRoutes(app)
registerRmmConnectRoutes(app)
registerRmmScopeRoutes(app)
registerRmmPatchingRoutes(app)
registerRmmAppPortalRoutes(app)
registerRmmNetworkDiscoveryRoutes(app)
registerRmmRecoveryKeyRoutes(app)

app.get('/api/v1/openapi.json', (c) => c.json(buildOpenApiDocument(app, deployment)))

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((error, c) => {
  console.error('Unhandled API error', error)
  if (error?.status && Number.isInteger(Number(error.status))) return c.json({ error: error.message || 'Request failed.' }, Number(error.status))
  return c.json({ error: 'Internal server error' }, 500)
})

console.log('[API] Routes registered; checking PostgreSQL...')
await pool.query('SELECT 1')
console.log('[API] PostgreSQL ready; connecting to Redis...')
await ensureRedisConnected()
console.log('[API] Redis ready; initializing RMM agent broker...')
await initializeAgentBroker()
console.log('[API] RMM agent broker initialized; starting schedulers...')
startLicensingRefreshScheduler()
startReleaseFeedScheduler()
if (backgroundWorkersEnabled) {
  startMicrosoftSyncScheduler()
  startRmmVulnerabilitySyncScheduler()
  startSoftwareVendorSyncScheduler()
  startTenantVendorSourceScheduler()
  startRmmNetworkDiscoveryScheduler()
  startRmmMacOuiScheduler()
} else {
  console.log('Background workers disabled for this Control Server instance')
}
console.log('[API] Starting HTTP listener...')
const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port })
attachRmmAgentWebSocket(server)
attachRmmViewerWebSocket(server)
attachRmmConnectWebSockets(server)
attachRmmDeviceToolWebSocket(server)
console.log(`Hi5Central API listening on port ${port}`)
if (deployment.runtimeEnvironment === 'live' && process.env.TENANT_SANDBOX_BACKFILL_ENABLED === 'true') {
  void backfillCompletedTenantSandboxes().catch(error => {
    console.error('Tenant sandbox rollout backfill failed', {code:error.code || 'UNKNOWN'})
  })
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`)
  server.close(async () => {
    try {
      await shutdownAgentBroker().catch((error) => console.error('RMM Agent broker shutdown failed', error))
      if (redis.isOpen) await redis.quit()
      await pool.end()
    } finally {
      process.exit(0)
    }
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
