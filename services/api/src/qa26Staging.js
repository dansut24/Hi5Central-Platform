/** Optional QA-only sidecar gate. Never set QA26_STAGING_MODE on a shared runtime. */
export const QA26_TENANTS=Object.freeze(['h5c-managed-qa26','h5c-custom-qa26'])
export function qa26StagingActive(env=process.env) {
  return env.QA26_STAGING_MODE==='true'
}
export function qa26TenantAllowed(slug) {
  return QA26_TENANTS.includes(String(slug||'').toLowerCase())
}
export function qa26ExpectedOrigins(environment) {
  if(!['live','test','uat'].includes(environment))return []
  const suffix=environment==='live'?'':'-'+environment
  const tenants=environment==='uat'?['h5c-custom-qa26']:QA26_TENANTS
  return tenants.map(slug=>'https://'+slug+suffix+'.hi5central.com')
}
export function qa26CanServe(origin,environment,path) {
  if(path==='/api/v1/internal/organisation/directory-snapshot'&&environment==='live')return true
  return qa26ExpectedOrigins(environment).includes(String(origin||''))
}
export function qa26ServiceDirectoryHeaders(enabled) {
  return enabled?{'X-Hi5-QA26-Internal':'pr69'}:{}
}
