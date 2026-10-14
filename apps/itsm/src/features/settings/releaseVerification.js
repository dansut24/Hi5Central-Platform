const SHA=/^[0-9a-f]{40}$/i
const ALLOWED=new Set(['dev','test','uat','live'])
export const RELEASE_VERIFICATION_FEATURE='release-verification-v1'

export function parseReleaseManifest(data){
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('The server did not return release metadata.')
  const buildSha=String(data.sha||'').trim().toLowerCase()
  if(!SHA.test(buildSha))throw Error('The frontend release manifest does not contain an immutable build SHA.')
  return {buildSha,shortSha:buildSha.slice(0,8),version:String(data.versionLabel||data.version||'').slice(0,64)}
}

export function buildReleaseVerificationReceipt({manifest,environment,hostname,checkedAt}){
  const parsed=parseReleaseManifest(manifest)
  if(!ALLOWED.has(String(environment)))throw Error('Unknown release environment.')
  if(!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(String(hostname||'')))throw Error('Invalid workspace hostname.')
  const stamp=new Date(checkedAt)
  if(!Number.isFinite(stamp.getTime()))throw Error('Invalid verification time.')
  return [
    'Hi5Central browser-release verification',
    'Feature: '+RELEASE_VERIFICATION_FEATURE,
    'Environment: '+environment.toUpperCase(),
    'Hostname: '+hostname.toLowerCase(),
    'Frontend SHA: '+parsed.buildSha,
    'Checked (UTC): '+stamp.toISOString(),
    'Scope: frontend manifest only — API, tenant assignment and public routing require separate host verification',
  ].join('\n')
}
