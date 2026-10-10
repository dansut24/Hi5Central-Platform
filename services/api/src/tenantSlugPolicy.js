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
