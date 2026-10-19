import {createHash} from 'node:crypto'

const hash=s=>createHash('sha256').update(s).digest('hex')
const SHA=/^[a-f0-9]{40}$/
const SLUG=/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/
const absent=()=>({present:false,route:'',start:-1,end:-1})
const invalid=reason=>{throw Error('CUSTOMER_ROLLBACK_ROUTE_DENIED: '+reason)}
/**
 * The canonical Caddyfile contains exactly one marker-delimited block for
 * each versioned customer route. Older "legacy" customer sites might have
 * no block and intentionally use the global api/itsm fallback. Fail closed
 * on malformed or duplicate markers.
 */
export function customerRouteBlock(caddy,hostname){
 if(typeof caddy!=='string'||!caddy.trim())invalid('Empty gateway source.')
 if(!/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]\.hi5central\.com$/.test(String(hostname||'')))
   invalid('Customer Production hostname is invalid.')
 const head='  # H5C_RELEASE_ROUTE_BEGIN '+hostname
 const foot='  # H5C_RELEASE_ROUTE_END '+hostname
 const start=caddy.indexOf(head)
 const end=caddy.indexOf(foot)
 if(start<0&&end<0)return absent()
 if(start<0||end<0||end<=start)invalid('Target customer route marker pair is corrupt.')
 if(caddy.indexOf(head,start+head.length)>=0||caddy.indexOf(foot,end+foot.length)>=0)
   invalid('Duplicate target customer route marker.')
 if(start>0&&caddy[start-1]!=='\n')invalid('Target route must start on its own line.')
 const routeEnd=end+foot.length
 if(routeEnd<caddy.length&&caddy[routeEnd]!=='\n')invalid('Target route must end on its own line.')
 const route=caddy.slice(start,routeEnd)
 const hosts=[...route.matchAll(/\bhost\s+([a-z0-9.-]+\.hi5central\.com)\b/g)].map(m=>m[1])
 if(hosts.length!==1||hosts[0]!==hostname)
   invalid('Target route content does not exclusively match the named customer.')
 return {present:true,route,start,end:routeEnd}
}
const drop=(source,block)=>block.present
  ?source.slice(0,block.start)+source.slice(block.end):source
// Compare unrelated Caddy directives and order without treating harmless
// whitespace or empty-line formatting differences as customer route changes.
const canonical=caddy=>caddy.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).join('\n')

export function planCustomerRouteRollback({
 hostname,fromBuildSha,toBuildSha,currentSource,previousSource,
 expectedCurrentGatewayHash,expectedPreviousGatewayHash
}){
 if(!SHA.test(String(fromBuildSha))||!SHA.test(String(toBuildSha))
   ||fromBuildSha===toBuildSha)
   invalid('Exact distinct 40-character source and target SHAs are required.')
 if(!String(currentSource||'').trim()||!String(previousSource||'').trim())
   invalid('Both original current and preserved previous gateway snapshots are mandatory.')
 const liveSha=hash(currentSource),backupSha=hash(previousSource)
 if(expectedCurrentGatewayHash&&liveSha!==expectedCurrentGatewayHash)
   invalid('Current gateway changed since host review.')
 if(expectedPreviousGatewayHash&&backupSha!==expectedPreviousGatewayHash)
   invalid('Previous gateway recovery snapshot hash differs from review.')
 const current=customerRouteBlock(currentSource,hostname)
 const old=customerRouteBlock(previousSource,hostname)
 if(!current.present)invalid('Current customer versioned route is absent.')
 if(!current.route.includes('hi5pool-live-'+fromBuildSha.slice(0,12)+'-api:3001')
   ||!current.route.includes('hi5pool-live-'+fromBuildSha.slice(0,12)+'-web:80'))
   invalid('Current target route does not serve the exact installed release.')
 if(old.present&&(!old.route.includes('hi5pool-live-'+toBuildSha.slice(0,12)+'-api:3001')
   ||!old.route.includes('hi5pool-live-'+toBuildSha.slice(0,12)+'-web:80')))
   invalid('Previous snapshot does not route to the exact prior versioned pool.')
 const unrelatedNow=canonical(drop(currentSource,current))
 const unrelatedBefore=canonical(drop(previousSource,old))
 if(unrelatedNow!==unrelatedBefore)
   invalid('Unrelated shared gateway directives changed since the preserved previous snapshot.')
 let restored=currentSource.slice(0,current.start)+(old.present?old.route:'')
   +currentSource.slice(current.end)
 // No other customer route may be created, removed, moved or rewritten.
 if(canonical(drop(restored,customerRouteBlock(restored,hostname)))!==unrelatedNow)
   invalid('Rollback candidate modified other customers or shared routes.')
 const restoredBlock=customerRouteBlock(restored,hostname)
 if(restoredBlock.present!==old.present||restoredBlock.route!==old.route)
   invalid('Rollback candidate does not exactly restore the prior customer route.')
 if(hash(restored)===liveSha)invalid('Rollback candidate did not change the Production route.')
 return {
   hostname,fromBuildSha,toBuildSha,mode:old.present?'previous_versioned_pool':'legacy_shared_fallback',
   currentSourceSha256:liveSha,previousSnapshotSha256:backupSha,
   restoredSourceSha256:hash(restored),
   verifiedUnrelatedRoutesUnchanged:true,previousRoutePresent:old.present,
   restoredSource:restored,
 }
}
