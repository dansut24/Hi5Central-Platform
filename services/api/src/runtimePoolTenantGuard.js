// Versioned pool-only tenant boundary. Ordinary shared APIs are unaffected.
// Exact Host, browser Origin and resolved tenant must all agree. This rejects
// requests made by a different tenant even if its cookie domain is shared.
const clean=value=>String(value||'').trim().toLowerCase()
const VALID_SLUG=/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/
const VALID_HOST=/^[a-z0-9-]+\.hi5central\.com$/

export function configuredPoolBoundary(env=process.env){
  const slug=clean(env.VERSIONED_POOL_TENANT_SLUG)
  const host=clean(env.VERSIONED_POOL_PUBLIC_HOST)
  if(!slug&&!host)return null
  if(!VALID_SLUG.test(slug)||!VALID_HOST.test(host)
    ||host!==slug+'.hi5central.com'
    ||!['uat','test'].includes(clean(env.RUNTIME_ENVIRONMENT)))
    throw Error('Invalid versioned pool tenant boundary configuration.')
  return Object.freeze({slug,host,origin:'https://'+host})
}
export function checkPoolTenantRequest({boundary,host,origin,referer,sessionSlug,
  path='',method='GET',authenticated=false}){
  if(!boundary)return {allowed:true}
  const actualHost=clean(host).replace(/:443$/,'')
  if(actualHost!==boundary.host)
    return {allowed:false,status:421,reason:'This tenant is not assigned to the requested runtime.'}
  const requestOrigin=clean(origin)
  if(requestOrigin&&requestOrigin!==boundary.origin)
    return {allowed:false,status:403,reason:'Cross-tenant browser origin rejected.'}
  let refererOrigin=''
  if(referer){
    try{refererOrigin=new URL(referer).origin.toLowerCase()}catch{
      return {allowed:false,status:403,reason:'Invalid browser referer.'}
    }
    if(refererOrigin!==boundary.origin)
      return {allowed:false,status:403,reason:'Cross-tenant referer rejected.'}
  }
  if(authenticated&&clean(sessionSlug)!==boundary.slug)
    return {allowed:false,status:403,reason:'Session belongs to a different tenant.'}
  if(!authenticated){
    // Pre-session access is an exact method/path allowlist. In particular,
    // the legacy password-only /auth/login route must not bypass MFA.
    if(method==='OPTIONS')return {allowed:true}
    const publicRequests=new Set([
      'POST /api/v1/auth/login-secure',
      'POST /api/v1/auth/mfa/setup',
      'POST /api/v1/auth/mfa/verify',
      'POST /api/v1/auth/environment-handoff',
      'POST /api/v1/auth/logout',
      'GET /api/v1/auth/session',
      'GET /api/v1/updates/version',
    ])
    if(publicRequests.has(method+' '+path))return {allowed:true}
    // Only this exact tenant can be queried during the login bootstrap.
    if(method==='GET'&&(
      path==='/api/v1/auth/tenant-state/'+boundary.slug
      ||path==='/api/v1/auth/tenant-slug/'+boundary.slug
    ))return {allowed:true}
    return {allowed:false,status:401,reason:'Canary session required.'}
  }
  return {allowed:true}
}
