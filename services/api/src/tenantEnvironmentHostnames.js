// Managed customer environment names are reserved independently of whether
// their sandboxes have been provisioned. Do not route UAT/Test traffic to Live.
const SYSTEM_LABELS = new Set([
  'admin', 'api', 'app', 'auth', 'connect', 'dev', 'downloads', 'help',
  'login', 'mail', 'portal', 'production', 'prod', 'reseller', 'rmm',
  'signup', 'smtp', 'status', 'support', 'test', 'turn', 'uat', 'www',
  'dev-api', 'dev-rmm', 'dev-admin', 'dev-help', 'dev-downloads', 'dev-turn',
  'test-api', 'test-rmm', 'test-admin', 'uat-api', 'uat-rmm', 'uat-admin',
])

const CUSTOMER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/

export function isValidCustomerSlug(value) {
  const slug = String(value || '').trim().toLowerCase()
  return CUSTOMER_SLUG_PATTERN.test(slug)
    && !slug.includes('--')
    && !slug.endsWith('-rmm')
    && !slug.endsWith('-portal')
    && !slug.endsWith('uat')
    && !slug.endsWith('test')
    && !SYSTEM_LABELS.has(slug)
}

export function customerEnvironmentHostnames(slug, rootDomain = 'hi5central.com') {
  if (!isValidCustomerSlug(slug)) throw new Error('Invalid or reserved customer slug.')
  const domain = String(rootDomain || '').trim().toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.')) throw new Error('Invalid root domain.')
  const label = String(slug).trim().toLowerCase()
  return {
    live: `${label}.${domain}`,
    uat: `${label}uat.${domain}`,
    test: `${label}test.${domain}`,
  }
}

// This is classification only. A parsed hostname is NOT an authorised route.
// UAT/Test may serve data only after independent storage, credentials, session
// scope and outbound integrations have been provisioned and verified.
export function classifyManagedCustomerHostname(hostname, rootDomain = 'hi5central.com') {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '')
  const suffix = `.${String(rootDomain).toLowerCase()}`
  if (!host.endsWith(suffix)) return null
  const label = host.slice(0, -suffix.length)
  if (label.includes('.') || SYSTEM_LABELS.has(label)) return null
  for (const environment of ['uat', 'test']) {
    if (label.endsWith(environment)) {
      const tenantSlug = label.slice(0, -environment.length)
      return isValidCustomerSlug(tenantSlug) ? { tenantSlug, environment } : null
    }
  }
  return isValidCustomerSlug(label) ? { tenantSlug: label, environment: 'live' } : null
}

/**
 * Resolve per-customer origins for a *single* managed runtime environment.
 * This must not be used to assert that a reserved hostname is provisioned.
 */
export function managedTenantUrls(slug, rootDomain = 'hi5central.com', environment = 'live', { rmm = false } = {}) {
  if (!isValidCustomerSlug(slug)) throw new Error('Invalid or reserved managed tenant slug.')
  if (!['live', 'uat', 'test'].includes(environment)) throw new Error('Invalid managed environment.')
  const hostnames = customerEnvironmentHostnames(slug, rootDomain)
  const hostname = hostnames[environment]
  const label = hostname.slice(0, -String(rootDomain).length - 1)
  return {
    tenantUrl: `https://${hostname}`,
    portalUrl: `https://${label}-portal.${rootDomain}`,
    rmmUrl: rmm ? `https://${label}-rmm.${rootDomain}` : null,
  }
}

export function classifyManagedCustomerOrigin(origin, rootDomain = 'hi5central.com') {
  let parsed
  try { parsed = new URL(origin) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return null
  const host = parsed.hostname.toLowerCase()
  const domain = String(rootDomain).toLowerCase()
  const suffix = `.${domain}`
  if (!host.endsWith(suffix)) return null
  const label = host.slice(0, -suffix.length)
  let product = 'workspace'
  let baseHost = host
  if (label.endsWith('-portal')) {
    product = 'portal'
    baseHost = `${label.slice(0, -7)}${suffix}`
  } else if (label.endsWith('-rmm')) {
    product = 'rmm'
    baseHost = `${label.slice(0, -4)}${suffix}`
  }
  const resolved = classifyManagedCustomerHostname(baseHost, domain)
  return resolved ? { ...resolved, product } : null
}
