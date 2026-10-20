/** Trusted fail-closed identity for a customer's FIRST Test/UAT cutover.
 * An unassigned public sandbox is deliberately HTTP 503, not a Live release.
 * That exact response may stand in for a prior SHA only when the live Caddy
 * source has NO route for this tenant and retains the sandbox-only 503 guard.
 */
export function assertUnassignedSandboxBaseline({
 environment,host,source,status,body
}={}){
 if(!['test','uat'].includes(environment))
   throw Error('Only a first Test/UAT deployment may lack a prior release.')
 if(!/^[a-z0-9-]+-(test|uat)\.hi5central\.com$/.test(String(host||''))
   ||!host.endsWith('-'+environment+'.hi5central.com'))
   throw Error('First-deployment hostname or stage is invalid.')
 if(typeof source!=='string'
   ||source.includes('  # H5C_RELEASE_ROUTE_BEGIN '+host)
   ||!source.includes('@h5cUnassignedSandbox expression')
   ||!source.includes('respond "Environment not yet deployed" 503'))
   throw Error('First sandbox deployment requires an unassigned guarded Caddy route.')
 if(String(status)!=='503'||String(body).trim()!=='Environment not yet deployed')
   throw Error('The public sandbox is not the verified undeployed 503 endpoint.')
 return {sha:null,unassigned:true}
}

/**
 * First Managed/Custom Production installation may currently be served by the
 * generic onboarding fallback, even when that fallback already runs the same
 * approved SHA. A shared response is NOT a tenant-specific baseline.
 *
 * Fail closed unless the customer has no individual route, the wildcard
 * gateway fallback is visibly configured, and public API + web are exactly
 * the requested certified build. No previous rollback-capable SHA exists.
 */
export function assertUnassignedLiveFallbackBaseline({
 environment,host,source,apiSha,webSha,targetSha,
}={}){
 const SHA=/^[a-f0-9]{40}$/
 if(environment!=='live'
   ||!/^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])?\\.hi5central\\.com$/.test(String(host||''))
   ||host.endsWith('-test.hi5central.com')||host.endsWith('-uat.hi5central.com'))
   throw Error('First Live installation must target one valid Production tenant hostname.')
 if(typeof source!=='string'
   ||source.includes('  # H5C_RELEASE_ROUTE_BEGIN '+host)
   ||!source.includes('  # H5C_RELEASE_ROUTE_INSERT')
   ||!source.includes('reverse_proxy api:3001')
   ||!source.includes('reverse_proxy itsm:80'))
   throw Error('First Live installation requires the verified unassigned shared fallback.')
 if(!SHA.test(String(targetSha||''))||apiSha!==targetSha||webSha!==targetSha)
   throw Error('Shared signup API/frontend must match the approved first Production build.')
 return {sha:null,unassigned:true}
}
