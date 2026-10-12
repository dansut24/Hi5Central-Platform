// Host-side policy gate. This file does not authorise, sign or activate routes.
// Every actual activation must also pass the original signed transaction checks.
import {verifyHostRouteIntent,renderVerifiedTenantRoute,runHostRouteTransaction} from './runtimeHostRouteTransaction.js'
import {QA_RELEASE_TARGETS,releaseTargetHost} from './qaReleasePlan.js'

const exactTarget=(intent)=>{
  const match=QA_RELEASE_TARGETS.find(t=>t.tenantSlug===intent?.tenantSlug&&
    t.environment===intent?.environment)
  if(!match||releaseTargetHost(match)!==intent?.publicHost)
    throw Error('Only the three named Managed/Custom QA sandbox hosts are authorised.')
  return match
}

export function validateQaSandboxHostIntent({intent,signature,publicKeyPem,now=new Date()}){
  // Verify the complete signed payload, including the current gateway hash.
  verifyHostRouteIntent({intent,signature,publicKeyPem,now})
  const match=exactTarget(intent)
  const expectedGateway='hi5central-'+match.environment+'-gateway'
  if(intent.gateway!==expectedGateway||
      intent.releaseScope!=='qa_sandbox_only'||
      intent.approvalEnvironment!=='QA Sandbox Release Approval'||
      !/^[1-9]\d{3,17}$/.test(String(intent.approvedRunId||''))||
      !/^[a-f0-9]{64}$/.test(String(intent.apiImageDigest||''))||
      !/^[a-f0-9]{64}$/.test(String(intent.webImageDigest||'')))
    throw Error('A signed QA-only gateway, approval run and exact image digests are required.')
  if(!intent.nextUpstream.startsWith('hi5pool-'+match.environment+'-')||
      !intent.nextApiTarget.startsWith('hi5pool-'+match.environment+'-')||
      !intent.previousUpstream.startsWith('hi5pool-'+match.environment+'-')||
      !intent.previousApiTarget.startsWith('hi5pool-'+match.environment+'-'))
    throw Error('Gateway targets must stay within the selected sandbox environment.')
  // Production hosts, Managed UAT, and central API/Production backends are excluded.
  if(match.tenantSlug==='h5c-managed-qa26'&&match.environment==='uat')
    throw Error('Managed QA has no UAT.')
  return {tenantSlug:match.tenantSlug,environment:match.environment,
    gateway:expectedGateway,host:intent.publicHost,buildSha:intent.buildSha}
}

export function inspectQaSandboxGatewayRoutes({config,intent}){
  exactTarget(intent)
  if(!config||typeof config!=='string')throw Error('The gateway configuration is required.')
  // No automatic insertion of routing blocks into generic tenant-wide fallbacks.
  // The gateway owner must first provision these exact tenant-specific markers.
  const rendered=renderVerifiedTenantRoute(config,intent)
  if(rendered===config)throw Error('The signed target did not change the selected route.')
  return rendered
}

export async function runQaSandboxHostTransaction({
  intent,signature,publicKeyPem,adapter,now=new Date(),applyEnabled=false,
}){
  const scope=validateQaSandboxHostIntent({intent,signature,publicKeyPem,now})
  if(!adapter||typeof adapter.readActiveConfig!=='function')
    throw Error('A trusted, tenant-isolated host adapter is required.')
  // Reject an adapter configured for the wrong gateway even when the intent
  // is cryptographically valid. The adapter must expose its own fixed identity.
  if(adapter.gateway!==scope.gateway)
    throw Error('Host adapter gateway does not match the signed sandbox.')
  return runHostRouteTransaction({
    intent,signature,publicKeyPem,adapter,now,applyEnabled,
  })
}
