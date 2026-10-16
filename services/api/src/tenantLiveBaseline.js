/** Resolve public tenant version without trusting SPA HTML as an API response.
 * The only legacy exception is the two named QA26 Live tenants. They used
 * frontend SHA f51d... with a central API origin before exact-host routing.
 * Do not extend this exception to real customer names or Test/UAT.
 */
const SHA=/^[a-f0-9]{40}$/
const LEGACY_QA_LIVE=new Set(['h5c-managed-qa26','h5c-custom-qa26'])
const fail=message=>{throw Error('Tenant version proof denied: '+message)}
const readJson=raw=>{
  try{return JSON.parse(String(raw||''))}catch{return null}
}
export function resolveTenantCurrentRevision({
  environment,tenantSlug,versionResponse,manifestResponse=null,
  runtimeConfigResponse='',sharedApiVersionResponse=null,
}={}){
  const direct=readJson(versionResponse)
  if(direct!==null){
    if(!SHA.test(String(direct?.sha||'')))
      fail('Live version JSON did not contain an exact immutable SHA.')
    return {sha:direct.sha,source:'tenant-api'}
  }
  if(environment!=='live'||!LEGACY_QA_LIVE.has(tenantSlug))
    fail('HTML or invalid JSON is not acceptable as a tenant version.')
  if(!/^\s*<!(?:doctype)\s+html\b|^\s*<html\b/i.test(String(versionResponse||'')))
    fail('Legacy QA fallback requires an actual HTML frontend response.')
  const manifest=readJson(manifestResponse)
  const shared=readJson(sharedApiVersionResponse)
  if(!SHA.test(String(manifest?.sha||''))||!SHA.test(String(shared?.sha||'')))
    fail('Legacy QA manifest or central API version is not an immutable SHA.')
  if(!/\bapiUrl:\s*["']https:\/\/api[.]hi5central[.]com["']/.test(String(runtimeConfigResponse||'')))
    fail('Legacy QA frontend does not explicitly use trusted central Live API.')
  return {sha:manifest.sha,source:'legacy-qa-live-frontend',sharedApiSha:shared.sha}
}
