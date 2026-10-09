import { classifyManagedCustomerOrigin, managedTenantUrls } from './tenantEnvironmentHostnames.js'

function enumValue(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase()
  return allowed.includes(normalized) ? normalized : fallback
}

function cleanDomain(value, fallback = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
  return normalized || fallback
}

function cleanSlug(value, fallback = 'demo-tenant') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  return normalized || fallback
}

function cleanUrl(value, fallback = '') {
  const raw = String(value || '').trim()
  if (!raw) return fallback
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`
  } catch {
    return fallback
  }
}

function originOf(value) {
  try {
    return new URL(value).origin.toLowerCase()
  } catch {
    return ''
  }
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const deployment = Object.freeze((() => {
  const deploymentMode = enumValue(process.env.DEPLOYMENT_MODE, ['managed', 'self_hosted'], 'managed')
  const selfHostEdition = deploymentMode === 'self_hosted'
    ? enumValue(process.env.SELF_HOST_EDITION, ['standard', 'msp'], 'standard')
    : 'managed'
  const tenancyMode = enumValue(process.env.TENANCY_MODE, ['multi', 'single'], 'multi')
  const runtimeEnvironment = enumValue(process.env.RUNTIME_ENVIRONMENT, ['dev', 'test', 'uat', 'live'], 'live')
  const featureMode = enumValue(process.env.FEATURE_MODE, ['all_enabled', 'controlled'], runtimeEnvironment === 'dev' || runtimeEnvironment === 'test' ? 'all_enabled' : 'controlled')
  const rootDomain = cleanDomain(process.env.ROOT_DOMAIN, 'hi5central.com')
  const primaryTenantSlug = cleanSlug(process.env.PRIMARY_TENANT_SLUG)
  const defaultAppUrl = tenancyMode === 'single' ? `https://${rootDomain}` : ''
  const appUrl = cleanUrl(process.env.APP_URL, defaultAppUrl)
  const marketingUrl = cleanUrl(
    process.env.MARKETING_URL,
    deploymentMode === 'managed' ? `https://${rootDomain}` : appUrl,
  )
  const apiUrl = cleanUrl(process.env.API_URL, tenancyMode === 'single' ? appUrl : `https://api.${rootDomain}`)
  const portalUrl = cleanUrl(process.env.PORTAL_URL, tenancyMode === 'single' ? `${appUrl}/portal` : '')
  const rmmUrl = cleanUrl(process.env.RMM_URL, tenancyMode === 'single' ? `${appUrl}/rmm` : '')
  const adminUrl = deploymentMode === 'self_hosted' && selfHostEdition === 'standard'
    ? ''
    : cleanUrl(process.env.ADMIN_URL, `https://admin.${rootDomain}`)
  if (deploymentMode === 'managed' && tenancyMode === 'multi'
    && ['uat','test'].includes(runtimeEnvironment) && String(process.env.COOKIE_DOMAIN || '').trim()) {
    throw new Error('Managed UAT/Test must use host-only API session cookies (COOKIE_DOMAIN must be unset).')
  }

  return {
    deploymentMode,
    selfHostEdition,
    tenancyMode,
    runtimeEnvironment,
    featureMode,
    rootDomain,
    primaryTenantSlug,
    appUrl,
    marketingUrl,
    apiUrl,
    portalUrl,
    rmmUrl,
    adminUrl,
    // UAT and Test must not inherit parent-domain browser cookies from Live.
    // Explicit COOKIE_DOMAIN settings are honoured for legacy/self-hosted uses;
    // managed multi-tenant sandbox deployments reject broad domains below.
    cookieDomain: String(process.env.COOKIE_DOMAIN ?? (
      tenancyMode === 'multi' && !(deploymentMode === 'managed' && ['uat','test'].includes(runtimeEnvironment))
        ? `.${rootDomain}` : ''
    )).trim(),
  }
})())

export function tenantUrls(slug, { rmm = false } = {}) {
  const tenantSlug = cleanSlug(slug, deployment.primaryTenantSlug)
  if (deployment.tenancyMode === 'single') {
    return {
      tenantUrl: deployment.appUrl || `https://${deployment.rootDomain}`,
      portalUrl: deployment.portalUrl || `${deployment.appUrl}/portal`,
      rmmUrl: rmm ? (deployment.rmmUrl || `${deployment.appUrl}/rmm`) : null,
    }
  }

  // Keep legacy managed Production URLs unchanged during the migration.
  if (deployment.deploymentMode === 'managed' && ['uat','test'].includes(deployment.runtimeEnvironment)) {
    return managedTenantUrls(tenantSlug, deployment.rootDomain, deployment.runtimeEnvironment, { rmm })
  }

  return {
    tenantUrl: `https://${tenantSlug}.${deployment.rootDomain}`,
    portalUrl: `https://${tenantSlug}-portal.${deployment.rootDomain}`,
    rmmUrl: rmm ? `https://${tenantSlug}-rmm.${deployment.rootDomain}` : null,
  }
}

export function allowedRequestOrigin(origin) {
  if (!origin) return ''
  // Managed customer sandboxes never trust marketing/Admin or another
  // environment merely because those origins share the root domain.
  if (deployment.deploymentMode === 'managed' && deployment.tenancyMode === 'multi'
    && ['uat','test'].includes(deployment.runtimeEnvironment)) {
    const match = classifyManagedCustomerOrigin(origin, deployment.rootDomain)
    return match?.environment === deployment.runtimeEnvironment ? origin : ''
  }
  const normalized = String(origin).toLowerCase()
  const explicit = new Set([
    originOf(deployment.appUrl),
    originOf(deployment.marketingUrl),
    originOf(deployment.apiUrl),
    originOf(deployment.portalUrl),
    originOf(deployment.rmmUrl),
    originOf(deployment.adminUrl),
  ].filter(Boolean))

  if (explicit.has(normalized)) return origin

  if (deployment.tenancyMode === 'multi') {
    const root = escapeRegex(deployment.rootDomain)
    const matcher = new RegExp(`^https:\\/\\/[a-z0-9-]+(?:-portal|-rmm)?\\.${root}$`, 'i')
    if (matcher.test(origin)) return origin
  }

  if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(origin)) return origin
  return ''
}

export function originMatchesTenant(origin, slug) {
  if (!origin) return true
  // An environment-qualified origin may only authenticate against the
  // matching runtime database. Never accept customer Test/UAT on Live.
  if (deployment.deploymentMode === 'managed' && deployment.tenancyMode === 'multi'
    && ['uat','test'].includes(deployment.runtimeEnvironment)) {
    const match = classifyManagedCustomerOrigin(origin, deployment.rootDomain)
    if (!match || match.environment !== deployment.runtimeEnvironment || match.tenantSlug !== slug) return false
  }
  const normalized = String(origin).toLowerCase()
  const urls = tenantUrls(slug, { rmm: true })
  const expected = new Set([
    originOf(urls.tenantUrl),
    originOf(urls.portalUrl),
    originOf(urls.rmmUrl),
  ].filter(Boolean))
  return expected.has(normalized)
}

export function originMatchesTenantAccount(origin, slug) {
  if (originMatchesTenant(origin, slug)) return true
  if (!origin) return true
  // Central Admin is a different trust boundary from the sandbox API.
  if (deployment.deploymentMode === 'managed' && deployment.tenancyMode === 'multi'
    && ['uat','test'].includes(deployment.runtimeEnvironment)) return false
  const adminOrigin = originOf(deployment.adminUrl)
  return Boolean(adminOrigin && String(origin).toLowerCase() === adminOrigin)
}

export function portalRequestFromHeaders(origin = '', referer = '') {
  if (deployment.tenancyMode === 'single') {
    if (originOf(deployment.portalUrl) && originOf(deployment.portalUrl) !== originOf(deployment.appUrl)) {
      if (String(origin).toLowerCase() === originOf(deployment.portalUrl)) return true
    }
    try {
      const url = new URL(referer)
      return url.pathname === '/portal' || url.pathname.startsWith('/portal/')
    } catch {
      return false
    }
  }

  if (deployment.deploymentMode === 'managed' && deployment.tenancyMode === 'multi'
    && ['uat','test'].includes(deployment.runtimeEnvironment)) {
    let source = origin
    if (!source && referer) {
      try { source = new URL(referer).origin } catch { return false }
    }
    const match = classifyManagedCustomerOrigin(source, deployment.rootDomain)
    return match?.environment === deployment.runtimeEnvironment && match.product === 'portal'
  }
  const root = escapeRegex(deployment.rootDomain)
  const originMatcher = new RegExp(`^https:\\/\\/[a-z0-9-]+-portal\\.${root}(?::\\d+)?$`, 'i')
  if (originMatcher.test(origin)) return true
  try {
    const url = new URL(referer)
    return new RegExp(`^[a-z0-9-]+-portal\\.${root}$`, 'i').test(url.hostname)
  } catch {
    return false
  }
}

export function originMatchesPortalTenant(origin, referer, slug) {
  if (!origin) return true

  const normalizedOrigin = String(origin).toLowerCase()
  const urls = tenantUrls(slug, { rmm: true })

  if (deployment.tenancyMode === 'single') {
    if (!originMatchesTenant(origin, slug)) return false
    const appOrigin = originOf(urls.tenantUrl)
    const portalOrigin = originOf(urls.portalUrl)
    if (portalOrigin && portalOrigin !== appOrigin) return normalizedOrigin === portalOrigin
    return portalRequestFromHeaders(origin, referer)
  }

  return normalizedOrigin === originOf(urls.portalUrl)
}
