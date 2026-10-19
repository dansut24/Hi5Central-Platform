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
