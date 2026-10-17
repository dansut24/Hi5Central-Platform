/**
 * Customer-facing, clipboard-ready details for the exact running ITSM build.
 * Use the installed SHA from /api/v1/updates, never the latest available
 * release. A missing/unversioned image is intentionally not copyable.
 */
const SHA=/^[a-f0-9]{40}$/i
const ENVIRONMENTS=Object.freeze({
  dev:'Development',
  test:'Test',
  uat:'UAT',
  live:'Production',
})

export function formatInstalledVersionDetails({
  versionLabel,
  buildSha,
  environment,
}={}){
  const sha=String(buildSha||'').trim()
  if(!SHA.test(sha))return null
  const env=String(environment||'').toLowerCase()
  const version=String(versionLabel||'').replace(/[\r\n\t]+/g,' ').trim()
    .slice(0,80)||(env==='live'?'Not yet published':'Preview build')
  return [
    'Hi5Central ITSM',
    'Installed version: '+version,
    'Environment: '+(ENVIRONMENTS[env]||'Unknown'),
    'Build SHA: '+sha.toLowerCase(),
  ].join('\n')
}
