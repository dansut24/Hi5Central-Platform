const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/

/** Valid identifier for any existing tenant, including environment aliases. */
export function validExistingTenantSlug(slug) {
  return SLUG_PATTERN.test(String(slug || '')) && !String(slug).includes('--')
    && !String(slug).endsWith('-portal') && !String(slug).endsWith('-rmm')
}

/** Reserve -test/-uat for automatically provisioned environments. */
export function validNewTenantSlug(slug, reservedSlugs = new Set()) {
  return validExistingTenantSlug(slug)
    && String(slug).length <= 42
    && !String(slug).endsWith('-test')
    && !String(slug).endsWith('-uat')
    && !reservedSlugs.has(slug)
}

/**
 * Gateway-only tenant hostname parsing. Never infer a tenant from suffixes such as
 * -rmm, -portal, -test, or -uat. A canonical tenant slug is the sole workspace host.
 */
export function tenantSlugFromHostname(hostname, rootDomain, reservedSlugs = new Set()) {
  const host = String(hostname || '').toLowerCase()
  const root = String(rootDomain || '').toLowerCase()
  if (!root || host !== host.trim() || !host.endsWith('.' + root)) return null
  const slug = host.slice(0, -(root.length + 1))
  if (!slug || slug.includes('.')) return null
  return validNewTenantSlug(slug, reservedSlugs) ? slug : null
}

/** Keep pending-verification signups routable, but never expose archived tenants. */
export function tenantMayServeWorkspace(tenant) {
  return tenant?.status === 'active'
    && !['archived', 'purged', 'purge_pending', 'deleting'].includes(
      String(tenant.lifecycle_status || 'active').toLowerCase(),
    )
}
