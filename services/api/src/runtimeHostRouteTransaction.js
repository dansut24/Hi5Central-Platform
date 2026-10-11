import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto'

const shaPattern=/^[a-f0-9]{40}$/
const hashPattern=/^[a-f0-9]{64}$/
const slugPattern=/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/
const upstreamPattern=/^hi5pool-[a-z0-9-]+-web:80$/
const apiPattern=/^hi5pool-[a-z0-9-]+-api:3001$/
const environmentSuffix={live:'',uat:'-uat',test:'-test'}
const digest=data=>createHash('sha256').update(data).digest('hex')
const stable=v=>Array.isArray(v)?v.map(stable):v!==null&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v
export const canonicalRouteIntent=intent=>JSON.stringify(stable(intent))
const refuse=message=>{throw Error(message)}
const exactlyOne=(haystack,needle)=>haystack.split(needle).length===2

// An intent is authorised by a release-controller signature, never by a
// browser-supplied SHA, unsigned JSON or the host's current clock alone.
export function verifyHostRouteIntent({intent,signature,publicKeyPem,now=new Date()}){
 if(!intent||typeof intent!=='object'||Array.isArray(intent))
  refuse('Route intent is missing.')
 const {environment,tenantSlug,publicHost,buildSha,previousUpstream,
  nextUpstream,nextApiTarget,expectedCaddySha256,routeGeneration,issuedAt,expiresAt}=intent
 if(!Object.hasOwn(environmentSuffix,environment)||!slugPattern.test(tenantSlug||'')
   ||publicHost!==tenantSlug+environmentSuffix[environment]+'.hi5central.com'
   ||!shaPattern.test(buildSha||'')||!hashPattern.test(expectedCaddySha256||'')
   ||!upstreamPattern.test(previousUpstream||'')||!upstreamPattern.test(nextUpstream||'')
   ||!apiPattern.test(nextApiTarget||'')
   ||previousUpstream===nextUpstream
   ||!Number.isSafeInteger(routeGeneration)||routeGeneration<=0)
  refuse('Route intent does not match the approved tenant, immutable build or internal targets.')
 const time=now.getTime(),start=new Date(issuedAt).getTime(),end=new Date(expiresAt).getTime()
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>time||end<=time
   ||end-start>15*60*1000||time-start>15*60*1000)
  refuse('Route authorisation is expired, future-dated or outside the 15-minute limit.')
 if(!publicKeyPem||!(/^[A-Za-z0-9+/]+=*$/).test(String(signature||'')))
  refuse('Signed route authorisation is required.')
 const raw=Buffer.from(signature,'base64')
 if(raw.length!==64||!verifySignature(null,Buffer.from(canonicalRouteIntent(intent)),
   createPublicKey(publicKeyPem),raw))
  refuse('Route authorisation signature is invalid.')
 return intent
}

// The host modifies only a marked, tenant-specific routing block. It cannot
// replace a generic wildcard proxy, rewrite Caddy globally or cross tenants.
// Before onboarding automatic rollout the operator must insert these markers
// and verify their precedence over tenant-wide fallbacks.
export function renderVerifiedTenantRoute(current,intent){
 const marker=intent.environment+':'+intent.tenantSlug
 const begin='# HI5_RUNTIME_ROUTE_BEGIN '+marker
 const end='# HI5_RUNTIME_ROUTE_END '+marker
 if(!exactlyOne(current,begin)||!exactlyOne(current,end))
  refuse('A unique, operator-provisioned tenant routing block is required.')
 const left=current.indexOf(begin)+begin.length
 const right=current.indexOf(end,left)
 if(right<left)refuse('Tenant route marker order is invalid.')
 const block=current.slice(left,right)
 if(!block.includes('host '+intent.publicHost))
  refuse('Route is not bound to the approved hostname.')
 const old='reverse_proxy '+intent.previousUpstream
 if(!exactlyOne(block,old)||block.includes('reverse_proxy '+intent.nextUpstream))
  refuse('Expected previous tenant upstream does not match the active route.')
 const replacement=block.replace(old,'reverse_proxy '+intent.nextUpstream)
 const candidate=current.slice(0,left)+replacement+current.slice(right)
 if(candidate===current||candidate.length!==current.length+intent.nextUpstream.length-intent.previousUpstream.length)
  refuse('Route edit was not exactly one upstream replacement.')
 return candidate
}

// Runs only inside the authorised host adapter. It verifies the exact current
// config digest, preflights target health, and keeps a rollback snapshot before
// reloading Caddy. Any post-switch failure triggers rollback. DB proof is
// written only after public verification of the live route.
export async function runHostRouteTransaction({intent,signature,publicKeyPem,
 adapter,now=new Date(),applyEnabled=false}){
 verifyHostRouteIntent({intent,signature,publicKeyPem,now})
 const previous=await adapter.readActiveConfig()
 if(digest(previous)!==intent.expectedCaddySha256)
  refuse('The active Caddyfile changed since approval; re-authorise the release.')
 const candidate=renderVerifiedTenantRoute(previous,intent)
 const preview={environment:intent.environment,tenantSlug:intent.tenantSlug,
  buildSha:intent.buildSha,routeGeneration:intent.routeGeneration,
  from: intent.previousUpstream,to:intent.nextUpstream,
  currentDigest:digest(previous),candidateDigest:digest(candidate)}
 await adapter.validateCandidate(candidate)
 if(!applyEnabled)return {...preview,state:'dry_run',routingChanged:false}
 await adapter.verifyTargetBuild(intent)
 await adapter.preserveRollback(previous,preview)
 let switched=false
 try{
  switched=true
  await adapter.activateCandidate(candidate,intent)
  await adapter.verifyPublicRoute(intent)
  await adapter.recordActivation(intent,preview)
  return {...preview,state:'verified_active',routingChanged:true}
 }catch(error){
  if(switched){
   try{
    await adapter.restoreRollback(previous,intent)
    await adapter.verifyRestoredRoute(intent)
   }catch(rollbackError){
    throw new AggregateError([error,rollbackError],
      'Production routing failed and rollback could not be verified. Escalate immediately.')
   }
  }
  throw Error('Host cutover rolled back after verification failure: '+String(error.message||error))
 }
}
