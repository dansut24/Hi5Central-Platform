import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deployment } from './deploymentConfig.js'
import { qa26StagingActive,qa26ServiceDirectoryHeaders } from './qa26Staging.js'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function readDirectoryServiceSecret() {
  const path=process.env.ENV_IDENTITY_SHARED_SECRET_FILE
  return String(path?readFileSync(path,'utf8').trim():process.env.ENV_IDENTITY_SHARED_SECRET||'')
}
export function validDirectoryServiceToken(expected,authorization) {
  const match=/^Bearer\s+(.+)$/i.exec(String(authorization||'').trim())
  const received=match?.[1]||''
  return expected.length>=32 && received.length===expected.length &&
    timingSafeEqual(Buffer.from(expected),Buffer.from(received))
}
export function isDirectoryReference(tenantId,userId,environment) {
  return UUID.test(String(tenantId||''))&&UUID.test(String(userId||''))&&['test','uat'].includes(environment)
}
export function validateDirectorySnapshot(value) {
  if (!value||typeof value!=='object') throw new Error('Live directory returned an invalid response.')
  const groups=['people','teams','departments','sites','teamMemberships']
  if (!groups.every(group=>Array.isArray(value[group])&&value[group].length<=5000))
    throw new Error('Live directory response is incomplete.')
  return Object.fromEntries(groups.map(group=>[group,value[group]]))
}
/** Environment APIs only read directory data from Live; never fall back to stale local People. */
export async function readCanonicalDirectory(tenantId,userId,{
  environment=deployment.runtimeEnvironment,fetcher=fetch,apiUrl=process.env.ENV_IDENTITY_API_URL,
  secret=readDirectoryServiceSecret(),
}={}) {
  if (!isDirectoryReference(tenantId,userId,environment))
    throw new Error('Canonical directory read requires a valid sandbox session.')
  const base=String(apiUrl||'').trim().replace(/\/$/,'')
  if (!/^https:\/\/[^/?#]+$/i.test(base)||secret.length<32)
    throw new Error('Production directory authority is not configured.')
  const response=await fetcher(base+'/api/v1/internal/organisation/directory-snapshot',{
    method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+secret,...qa26ServiceDirectoryHeaders(qa26StagingActive())},
    body:JSON.stringify({tenantId,userId,environment}),signal:AbortSignal.timeout(6000),
  })
  if (!response.ok) throw new Error('The central People directory is unavailable or access was denied.')
  return validateDirectorySnapshot((await response.json())?.directory)
}
export function liveRmmAccessAllowed(environment) {
  // Dev is separately protected engineering; Test/UAT must never operate real remote sessions.
  return environment==='live'||environment==='dev'
}
