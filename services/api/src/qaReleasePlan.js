// Read-only QA release plan: NOT a signed release intent or a route assignment.
// The host release operator must independently authorise/attest any cutover.
export const QA_RELEASE_TARGETS=Object.freeze([
  Object.freeze({tenantSlug:'h5c-managed-qa26',environment:'test',updateMode:'hi5_managed'}),
  Object.freeze({tenantSlug:'h5c-custom-qa26',environment:'test',updateMode:'admin_controlled'}),
  Object.freeze({tenantSlug:'h5c-custom-qa26',environment:'uat',updateMode:'admin_controlled'}),
])

const sha=/^[0-9a-f]{40}$/
const label=/^v?\d+(?:\.\d+){1,3}(?:-(?:alpha|beta|rc)(?:[.-]?\d+)?)?$/i
const slugs=new Set(QA_RELEASE_TARGETS.map(x=>x.tenantSlug))
export function releaseTargetHost(item) {
  if(!item||!slugs.has(item.tenantSlug)||
    !QA_RELEASE_TARGETS.some(x=>x.tenantSlug===item.tenantSlug &&
      x.environment===item.environment&&x.updateMode===item.updateMode))
    throw Error('Target is not one of the approved QA sandbox hosts.')
  if(item.environment==='uat'&&item.updateMode!=='admin_controlled')
    throw Error('Managed customers cannot receive UAT.')
  return item.tenantSlug+'-'+item.environment+'.hi5central.com'
}
export function makeQaReleasePlan({buildSha,versionLabel,now=new Date()}){
  const selected=String(buildSha||'').trim().toLowerCase()
  const version=String(versionLabel||'').trim()
  if(!sha.test(selected))throw Error('An immutable, 40-character commit SHA is required.')
  if(!label.test(version))throw Error('A customer-visible, safe release version is required.')
  const instant=new Date(now)
  if(!Number.isFinite(instant.getTime()))throw Error('Invalid plan creation date.')
  const targets=QA_RELEASE_TARGETS.map(item=>({
    ...item,host:releaseTargetHost(item),
    origin:'https://'+releaseTargetHost(item),
    intent:'stage-only',hostApprovalRequired:true,
  }))
  if(new Set(targets.map(x=>x.host)).size!==targets.length)
    throw Error('Duplicate release target.')
  return Object.freeze({
    schemaVersion:1,kind:'unsigned_qa_release_proposal',stage:'dry_run',
    buildSha:selected,versionLabel:version,preparedAt:instant.toISOString(),
    targets,
    gates:{
      ci:'CI must pass for the exact commit and image digest.',
      test:'Authenticated Test checks required for both approved QA tenants.',
      uat:'Custom UAT requires login/MFA, navigation, records and mobile acceptance.',
      promotion:'Custom needs explicit owner approval; Managed must wait 24 hours and its maintenance window.',
      routing:'An independently signed operator intent, host attestation and rollback receipt are mandatory.',
    },
    activationAllowed:false,productionHostsIncluded:false,
  })
}
export function assessPublicRelease(plan,results){
  if(plan?.kind!=='unsigned_qa_release_proposal'||plan.activationAllowed!==false)
    throw Error('Only a read-only QA proposal can be assessed.')
  const expected=new Set(plan.targets.map(x=>x.host))
  if(!Array.isArray(results)||results.length!==expected.size ||
     new Set(results.map(x=>x.host)).size!==results.length ||
     results.some(x=>!expected.has(x.host)))
    throw Error('Public release results must match exactly the three QA hosts.')
  return results.map(item=>{
    const observed=String(item.frontendSha||'').trim().toLowerCase()
    const verified=sha.test(observed)&&observed===plan.buildSha&&item.httpStatus===200
    return {host:item.host,frontendSha:sha.test(observed)?observed:null,
      publicFrontendMatches:verified,
      state:verified?'frontend_manifest_matches':'not_yet_staged',
      apiVerified:false,hostRouteVerified:false,uatApproved:false,
      note:verified?'Frontend manifest matches; host API, route and approval are still unverified.':
        'Public frontend does not serve the candidate SHA yet; do not treat staging as complete.'}
  })
}
