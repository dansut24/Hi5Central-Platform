import {createHash} from 'node:crypto'
const sorted=value=>Array.isArray(value)?value.map(sorted):
 value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort()
  .map(k=>[k,sorted(value[k])])):value
const sha=x=>createHash('sha256').update(JSON.stringify(sorted(x))).digest('hex')
const hostKey=r=>r?.match?.length===1
 &&Array.isArray(r.match[0]?.host) &&r.match[0].host.length>0
 ?r.match[0].host.join(','):r?.match==null?'<catch-all>':null
const routeList=x=>x?.apps?.http?.servers?.srv0?.routes

/** Immutable read-only proof that every last-verified HTTPS host route still
 * serves its identical runtime semantics, except for exactly one independently
 * reviewed additive marketing preview. Never authorises gateway reload. */
export function verifyLiveGatewayRuntimeProvenance({lastVerified,active}={}){
 const result={verified:false,verifiedExistingRoutes:0,activeRoutes:0,
  previewPreserved:false,reason:'Invalid gateway route table.'}
 const prev=routeList(lastVerified),now=routeList(active)
 if(!Array.isArray(prev)||prev.length<8||!Array.isArray(now))
  return result
 const base=new Map(),runtime=new Map()
 for(const r of prev){
  const k=hostKey(r)
  if(!k||base.has(k))return {...result,reason:'Duplicate or ambiguous verified route matcher.'}
  base.set(k,r)
 }
 for(const r of now){
  const k=hostKey(r)
  if(!k||runtime.has(k))return {...result,reason:'Duplicate or ambiguous active route matcher.'}
  runtime.set(k,r)
 }
 const exact=[...base].filter(([k,v])=>runtime.has(k)&&sha(v)===sha(runtime.get(k)))
 result.verifiedExistingRoutes=exact.length
 result.activeRoutes=now.length
 if(exact.length!==base.size)return {...result,reason:'An existing protected gateway route changed.'}
 const extras=[...runtime.keys()].filter(k=>!base.has(k))
 if(extras.length!==1||extras[0]!=='marketing-preview.hi5central.com')
  return {...result,reason:'Unexpected added or removed gateway routes.'}
 const preview=runtime.get('marketing-preview.hi5central.com')
 const routes=preview?.handle?.[0]?.handler==='subroute'
  ?preview.handle[0].routes:null
 if(!Array.isArray(routes)||routes.length!==3||preview.handle.length!==1)
  return {...result,reason:'Marketing preview routing shape changed.'}
 const [signup,deny,proxy]=routes
 const path=x=>x?.match?.[0]?.path?.slice()?.sort()
 if(JSON.stringify(path(signup))!==JSON.stringify(['/signup','/signup/*'].sort())
  ||signup?.handle?.[0]?.handler!=='static_response'
  ||signup.handle[0].status_code!==302
  ||signup.handle[0].headers?.Location?.[0]!=='https://hi5central.com/signup')
  return {...result,reason:'Marketing preview signup isolation changed.'}
 if(JSON.stringify(path(deny))!==JSON.stringify(
   ['/api','/api/*','/auth','/auth/*','/admin','/admin/*'].sort())
  ||deny?.handle?.[0]?.handler!=='static_response'
  ||deny.handle[0].status_code!==404)
  return {...result,reason:'Marketing preview API denial changed.'}
 const h=proxy?.handle
 if(!Array.isArray(h)||h.length!==2
  ||h[0]?.handler!=='headers'||h[1]?.handler!=='reverse_proxy'
  ||h[0].response?.set?.['X-Hi5-Marketing-Preview']?.[0]!=='pr83'
  ||!h[0].response?.set?.['X-Robots-Tag']?.[0]?.includes('noindex')
  ||h[1]?.upstreams?.length!==1
  ||h[1].upstreams[0]?.dial!=='hi5central-marketing-pr83-preview-real:80')
  return {...result,reason:'Marketing preview target or metadata changed.'}
 return {...result,verified:true,previewPreserved:true,
  reason:'Active runtime preserves every verified host route and the isolated PR83 preview.'}
}
