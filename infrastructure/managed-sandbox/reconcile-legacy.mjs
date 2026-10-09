import { planRoutes } from './plan-routes.mjs'

// Pure, deterministic comparison. Never treats evidence collection as an
// operator approval, and never creates a Caddy/DNS/Docker change.
export function reconcileLegacy(snapshot, { environment, tenantSlug } = {}) {
  if (!snapshot || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.sharedEdgeMembers)) {
    throw new Error('A complete, sanitised Docker inventory is required.')
  }
  const environments = ['uat','test']
  const issues = []
  const routeOwners = new Map()
  for (const p of snapshot.projects) {
    for (const route of p.routes || []) {
      const host = String(route.hostname || '').toLowerCase()
      if (!/^[a-z0-9.-]+$/.test(host)) continue
      const holders=routeOwners.get(host) || new Set()
      holders.add(p.name)
      routeOwners.set(host,holders)
    }
  }
  const existing = {}
  for(const env of environments) {
    const projectName=`hi5central-${env}`
    const legacy=snapshot.projects.find(p=>p.name===projectName)
    if(!legacy) {
      issues.push(`UNKNOWN_LEGACY_${env.toUpperCase()}: project is missing from this inventory`)
      existing[env]={found:false}
      continue
    }
    const containers=legacy.containers || []
    const api=containers.find(c=>c.service==='control-server')
    const names=new Set(containers.map(c=>c.service))
    const legacyNetwork=`hi5central-${env}_hi5internal`
    const gateway=containers.find(c=>c.service==='gateway')
    existing[env]={
      found:true,
      runtimeMode:api?.tenancyMode || 'unverified',
      runtimeEnvironment:api?.runtimeEnvironment || 'unverified',
      runningContainers:containers.filter(c=>c.state==='running').length,
      serviceNames:[...names].sort(),
      hasDatabase:names.has('postgres'),
      hasRedis:names.has('redis'),
      hasRmm:names.has('rmm-web'),
      hasTurn:names.has('turn'),
      legacyNetwork,
      gatewayNetworks:gateway?.networks||[],
      volumeNames:(legacy.volumes||[]).slice().sort(),
      gateways:legacy.routes||[],
    }
    if (api?.tenancyMode!=='single' || api.runtimeEnvironment!==env){
      issues.push(`UNVERIFIED_LEGACY_MODE_${env.toUpperCase()}: runtime identity does not match expected legacy single-tenant mode`)
    }
    if(!names.has('postgres') || !names.has('redis') || !names.has('gateway'))
      issues.push(`INCOMPLETE_LEGACY_${env.toUpperCase()}: expected DB/Redis/gateway not inventoried`)
    if(gateway && !gateway.networks.includes('hi5central'))
      issues.push(`EDGE_NOT_INVENTORIED_${env.toUpperCase()}: legacy gateway network requires manual verification`)
    for(const c of containers) {
      if ((c.networks||[]).some(n=>n.startsWith('hi5central-sandbox-')))
        issues.push(`PILOT_NETWORK_COLLISION_${env.toUpperCase()}: legacy container is already attached to a pilot network`)
    }
  }
  const plans={}
  for(const env of environment?[environment]:environments){
    const base=planRoutes(env,tenantSlug || 'pilotexample')
    const canonicalApi=new URL(base.apiOrigin).hostname
    const pilotApi=`pilot-${env}-api.hi5central.com`
    const requiredHosts=[
      canonicalApi,new URL(base.customerWorkspace).hostname,
      new URL(base.customerPortal).hostname,
    ]
    const conflicts=requiredHosts.filter(h=>routeOwners.has(h))
      .map(h=>({hostname:h,owners:[...routeOwners.get(h)].sort()}))
    const pilotApiConflict=routeOwners.has(pilotApi)
    if (conflicts.length) {
      issues.push(`CANONICAL_ROUTE_CONFLICT_${env.toUpperCase()}: ${conflicts.map(c=>c.hostname).join(', ')} already assigned`)
    }
    if(pilotApiConflict) issues.push(`PILOT_API_CONFLICT_${env.toUpperCase()}: alternate API hostname already assigned`)
    plans[env]={
      canonicalApiOrigin:base.apiOrigin,
      alternateUnpublishedApiOrigin:`https://${pilotApi}`,
      customerWorkspace:base.customerWorkspace,
      customerPortal:base.customerPortal,
      legacyConflicts:conflicts,
      alternateApiClaimed:pilotApiConflict,
      expectedIsolatedEdgeNetwork:base.expectedEdgeNetwork,
      candidateOnly:true,
      recommendedMode:'parallel-non-disruptive',
      DNSChanges:false,TLSChanges:false,runtimeChanges:false,
    }
  }
  if(snapshot.sharedEdgeMembers.some(x=>/postgres|redis/.test(x))) {
    issues.push('SHARED_EDGE_CONTAINS_DATA_SERVICES: legacy shared gateway network includes database/cache containers')
  }
  if(snapshot.sharedEdgeMembers.some(x=>x.startsWith('hi5-sandbox-'))) {
    issues.push('PILOT_SHARED_EDGE_VIOLATION: sandbox container attached to shared legacy network')
  }
  if(!snapshot.gatewayEvidenceComplete) issues.push('GATEWAY_EVIDENCE_INCOMPLETE: route audit is not exhaustive')
  if(!snapshot.dnsTlsIndependentlyVerified) issues.push('DNS_TLS_UNVERIFIED: DNS resolution alone does not prove TLS or routing ownership')
  return {
    schemaVersion:1,
    status:'blocked_pending_operator_review',
    existing,
    plans,
    issues:[...new Set(issues)],
    productionChangesAllowed:false,
    legacyRemovalAllowed:false,
    pilotActivationAllowed:false,
    routeChangesAllowed:false,
    requiredHumanDecisions:[
      'Classify legacy UAT/Test data and service owners; approve retain/coexist/migration disposition',
      'Verify backups and restoration evidence before any legacy service retirement',
      'Approve two distinct gateway-facing sandbox edge networks and memberships',
      'Prove DNS/TLS hostname ownership and no wildcard Production fallback for reserved UAT/Test names',
      'Obtain independently authenticated approval of an isolated pilot with rollback plan',
    ],
  }
}
