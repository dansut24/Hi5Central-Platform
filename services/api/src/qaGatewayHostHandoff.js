// Source of truth for the public Caddy -> private QA Caddy handoff.
// The public edge MUST replace (never append / forward) the incoming header
// for every request bound for the QA gateway, including the legacy fallback.
// Otherwise an attacker can supply a tenant hostname in a forged header.
const QA={test:{upstream:'hi5central-test-gateway:80',shared:'test.hi5central.com'},
  uat:{upstream:'hi5central-uat-gateway:80',shared:'uat.hi5central.com'}}
const allowed=/^[a-z][a-z0-9-]{2,62}:80$/

export function renderQaOuterHandoff(environment,{upstream=QA[environment]?.upstream}={}){
  const q=QA[environment]
  if(!q||!allowed.test(String(upstream||'')))throw Error('Unrecognised QA gateway upstream.')
  const matcher=environment==='test'?'tenantTestWorkspace':'tenantUatWorkspace'
  const sharedMatcher=environment==='test'?'sharedTestWorkspace':'sharedUatWorkspace'
  const pattern=`(?i)^[a-z0-9-]+-${environment}[.]hi5central[.]com$`
  return [
    '# Scoped QA handoff only. Import *within* the authenticated HTTPS edge site',
    '# before any wider fallback route. All paths, not just /api.',
    '@'+matcher+' expression {http.request.host}.matches(\''+pattern+'\')',
    'handle @'+matcher+' {',
    '    reverse_proxy '+upstream+' {',
    '        # Critically overwrite any client-supplied value on EVERY request.',
    '        header_up X-Hi5-Tenant-Host {http.request.host}',
    '        header_up Host '+q.shared,
    '    }',
    '}',
    '# The shared QA hostname must also clear any forged tenant hint.',
    '@'+sharedMatcher+' host '+q.shared,
    'handle @'+sharedMatcher+' {',
    '    reverse_proxy '+upstream+' {',
    '        header_up X-Hi5-Tenant-Host '+q.shared,
    '        header_up Host '+q.shared,
    '    }',
    '}',
  ].join('\n')+'\n'
}

export function validateQaHandoffCoverage(caddyfile,environment){
  // Advisory linter only: CI verifies actual HTTP flow through both proxies.
  // The live operator must also inspect ALL edge paths targeting QA.
  const q=QA[environment]
  if(!q)throw Error('Invalid QA environment.')
  const proxies=[...String(caddyfile||'').matchAll(/reverse_proxy\s+([^\s{]+)\s*\{([^}]+)\}/g)]
    .filter(match=>match[1]===q.upstream)
  if(proxies.length===0)throw Error('No QA upstream found in gateway handoff.')
  if(proxies.some(([,upstream,block])=>!block.includes('header_up X-Hi5-Tenant-Host ')))
    throw Error('An outer QA proxy could forward an untrusted client tenant header.')
  return {environment,checkedQaProxies:proxies.length,clientHeaderOverridden:true}
}
