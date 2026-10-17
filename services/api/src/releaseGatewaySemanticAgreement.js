import {createHash} from 'node:crypto'
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stable=value=>Array.isArray(value)?value.map(stable):
 value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value
const routes=config=>config?.apps?.http?.servers?.srv0?.routes
const key=route=>route?.match?.length===1
 &&route.match[0].host?.length>0
 ?route.match[0].host.join(','):
 route?.match==null?'<catch-all>':null
const previewName='marketing-preview.hi5central.com'
const expectedDenied=['/api','/api/*','/auth','/auth/*','/admin','/admin/*'].sort()
const samePaths=(actual,wanted)=>JSON.stringify((actual||[]).slice().sort())
 ===JSON.stringify(wanted)
function semanticRoute(route){
 const groups=new Map()
 const visit=(value,k='')=>{
  if(Array.isArray(value))return value.map(v=>visit(v,k))
  if(value&&typeof value==='object')
   return Object.fromEntries(Object.keys(value).sort().map(p=>[p,visit(value[p],p)]))
  if(k==='group'&&typeof value==='string'&&/^group[0-9]+$/.test(value)){
   if(!groups.has(value))groups.set(value,'group-'+groups.size)
   return groups.get(value)
  }
  if(k==='hide'&&typeof value==='string'&&[
   '/tmp/staff-verified-upgrade-1792092421202.Caddyfile',
   '/tmp/h5c79-review-candidate.Caddyfile',
   '/tmp/h5c79-validated-reconciliation-Caddyfile',
   '/etc/caddy/Caddyfile',
   '/tmp/h5c-release-executor.Caddyfile',
  ].includes(value))return '<verified-caddy-source>'
  return value
 }
 return visit(route)
}
function leafRoutes(root){
 const list=[]
 const visit=(route)=>{
  if(!route||typeof route!=='object')return false
  const handlers=route.handle
  if(!Array.isArray(handlers)||!handlers.length)return false
  if(handlers.length===1&&handlers[0]?.handler==='subroute'){
   const nested=handlers[0].routes
   if(!Array.isArray(nested)||!nested.length)return false
   return nested.every(visit)
  }
  if(handlers.some(h=>h?.handler==='subroute'))return false
  list.push({path:route?.match?.[0]?.path||null,handlers})
  return true
 }
 return visit(root)?list:null
}
function previewOkay(preview){
 if(key(preview)!==previewName||preview?.terminal!==true)return false
 const leaves=leafRoutes(preview)
 if(!leaves||leaves.length!==3)return false
 const [signup,denied,content]=leaves
 if(!samePaths(signup.path,['/signup','/signup/*'])
  ||signup.handlers.length!==1
  ||signup.handlers[0]?.handler!=='static_response'
  ||signup.handlers[0]?.status_code!==302
  ||signup.handlers[0]?.headers?.Location?.[0]!=='https://hi5central.com/signup')
  return false
 if(!samePaths(denied.path,expectedDenied)
  ||denied.handlers.length!==1
  ||denied.handlers[0]?.handler!=='static_response'
  ||denied.handlers[0]?.status_code!==404)return false
 if(content.path!=null)return false
 const proxy=content.handlers.filter(h=>h.handler==='reverse_proxy')
 const headers=content.handlers.filter(h=>h.handler==='headers')
 if(proxy.length!==1||proxy[0]?.upstreams?.length!==1
  ||proxy[0].upstreams[0]?.dial!=='hi5central-marketing-pr83-preview-real:80'
  ||headers.length<1||headers.length>2
  ||headers.length+proxy.length!==content.handlers.length)return false
 const combined=Object.assign({},...headers.map(h=>h?.response?.set||{}))
 return combined['X-Hi5-Marketing-Preview']?.length===1
  &&combined['X-Hi5-Marketing-Preview'][0]==='pr83'
  &&combined['X-Robots-Tag']?.length===1
  &&combined['X-Robots-Tag'][0]==='noindex, nofollow, noarchive'
}
/** Only permits a known Caddy-generated nesting/group/source-path difference
 * on a preserved route and the EXACT independently reviewed PR83 semantics.
 * Does not permit extra or removed hosts or any other upstream change.
 */
export function verifySemanticReleaseGatewayAgreement({adaptedRuntime,loadedRuntime}={}){
 const a=typeof adaptedRuntime==='string'?JSON.parse(adaptedRuntime):adaptedRuntime
 const b=typeof loadedRuntime==='string'?JSON.parse(loadedRuntime):loadedRuntime
 const x=routes(a),y=routes(b)
 const failure=reason=>({same:false,reason})
 if(!Array.isArray(x)||!Array.isArray(y)||x.length!==12||y.length!==12)
  return failure('Not the reviewed twelve-route Live gateway.')
 const namesX=x.map(key),namesY=y.map(key)
 if(namesX.includes(null)||namesY.includes(null)||new Set(namesX).size!==12
  ||new Set(namesY).size!==12)
  return failure('Missing or ambiguous gateway matcher.')
 if(JSON.stringify(namesX.filter(n=>n!==previewName))
  !==JSON.stringify(namesY.filter(n=>n!==previewName)))
  return failure('Existing protected host ordering changed.')
 if(namesX.filter(n=>n===previewName).length!==1
  ||namesY.filter(n=>n===previewName).length!==1)
  return failure('The reviewed marketing preview is missing or duplicated.')
 const aBy=new Map(x.map(r=>[key(r),r]))
 const bBy=new Map(y.map(r=>[key(r),r]))
 for(const [host,route] of aBy){
  if(!bBy.has(host))return failure('An existing gateway host matcher is absent.')
  if(host===previewName)continue
  if(sha(stable(semanticRoute(route)))!==sha(stable(semanticRoute(bBy.get(host)))))
   return failure('Protected gateway route changed: '+host.slice(0,130))
 }
 if(!previewOkay(aBy.get(previewName))||!previewOkay(bBy.get(previewName)))
  return failure('Preview redirect, API denial, headers or upstream is not approved.')
 return {same:true,reason:'Eleven protected routes match; preview semantics match.',
  preservedProtectedRoutes:11,approvedPreview:true}
}
