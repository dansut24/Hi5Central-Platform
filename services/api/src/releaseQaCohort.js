/** Fail-closed QA cohort for pre-certification real-host acceptance.
 * Exact tenant slugs only: no patterns, wildcard, env expansion or defaults.
 * This prevents a published QA release from fanning out to unrelated customers.
 */
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/
export function parseQaReleaseTenantSlugs(raw){
  if(typeof raw!=='string'||raw.length===0||raw.length>1200)
    throw Error('QA rollout must specify an explicit nonempty tenant allowlist.')
  const values=raw.split(',').map(s=>s.trim())
  if(values.length<1||values.length>24||values.some(s=>!SLUG.test(s)))
    throw Error('QA rollout tenant allowlist contains an invalid slug.')
  if(new Set(values).size!==values.length)
    throw Error('QA rollout tenant allowlist cannot include duplicate slugs.')
  return Object.freeze(values)
}
export function assertQaReleaseTenantAllowed(slug,allowlist){
  if(!Array.isArray(allowlist)||allowlist.length<1||!allowlist.includes(String(slug||'')))
    throw Error('Tenant is outside the explicit QA-only release cohort.')
  return true
}
