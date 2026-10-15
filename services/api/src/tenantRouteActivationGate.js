import {activeTenantMaintenanceWindow} from './releaseRolloutPlanner.js'
import {routeCutoverPrecondition} from './tenantRouteCutover.js'

const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const fail=(reason,stage='unknown')=>({allowed:false,stage,reason})
const parsedDate=value=>{
  if(value==null||value==='')return null
  const date=new Date(value)
  return Number.isFinite(date.getTime())?date:null
}
const completedFor=(e,sha)=>{
  if(e?.sha!==sha||e?.state!=='succeeded')return null
  return parsedDate(e.completedAt)
}

/**
 * A last-millisecond authorisation check for the trusted host worker.
 * It has NO side effects: it neither grants a lease, switches a gateway nor
 * signs a deployment proof. The privileged host worker MUST independently
 * verify current DB state, Docker health, private gateway reachability and
 * signed service identity immediately before applying a generation.
 *
 * Full Live/Custom approvals remain separate gates: a Test CI pass alone
 * cannot make any Production tenant eligible.
 */
export function verifyTenantRouteActivation({
  tenant,job,plan,release,gates={},gatewayObservedSha256,
  now=new Date(),allowLive=false,
}={}){
  const stage=String(job?.environment||'unknown')
  const deny=reason=>fail(reason,stage)
  const at=parsedDate(now),sha=job?.build_sha
  if(!at)return deny('Current worker clock is invalid.')
  if(!tenant||!job||!plan||!release
    ||!UUID.test(String(tenant.id||''))
    ||!UUID.test(String(job.id||''))
    ||!UUID.test(String(job.lease_token||''))
    ||!SHA.test(String(sha||''))
    ||!['test','uat','live'].includes(stage))
    return deny('Tenant, build and exclusive worker lease must be verified.')
  if(!['hi5_managed','admin_controlled'].includes(tenant.mode)
    ||tenant.status!=='active'||tenant.itsmEntitled!==true
    ||(stage==='uat'&&tenant.mode!=='admin_controlled'))
    return deny('Tenant lacks active ITSM entitlement for this environment.')
  if(job.tenant_id!==tenant.id||job.status!=='running'||job.lease_fence!==plan.leaseFence
    ||job.environment!==plan.environment||job.id!==plan.jobId||plan.tenantId!==tenant.id
    ||plan.buildSha!==sha)
    return deny('Lease, route plan or tenant does not match current job.')
  const leaseExpiry=parsedDate(job.lease_expires_at),started=parsedDate(job.scheduled_at)
  if(!leaseExpiry||!started||leaseExpiry<=at||started>at)
    return deny('Lease expired or customer rollout time has not arrived.')
  if(release.sha!==sha||release.published!==true||release.humanApproved!==true
    ||release.ciPassed!==true||release.securityPassed!==true
    ||release.migrationCompatible!==true)
    return deny('Published human-approved and CI/security/migration-compatible exact release required.')
  if(gates.platformPaused!==false)
    return deny('Platform-wide kill switch is active or unverified.')
  // Full remaining deployment duration, including a customer blackout.
  const window=activeTenantMaintenanceWindow({
    policy:tenant.maintenance,now:at,
    durationMinutes:job.expected_duration_minutes,
    blackouts:tenant.blackouts,
  })
  if(!window.allowed)return deny(window.reason)
  if(gates.hostPoolHealthy!==true||gates.hostRouteProofReady!==true)
    return deny('Actual immutable pool health and gateway readiness are unverified.')

  if(stage!=='test'){
    const testDone=completedFor(gates.test,sha)
    const soak=Number(release.testSoakMinutes)
    if(!testDone||!Number.isInteger(soak)||soak<30||soak>10080
      ||testDone>at||at.getTime()<testDone.getTime()+soak*60000)
      return deny('Exact Test release completion and minimum soak are required.')
  }
  if(stage==='uat'&&tenant.mode!=='admin_controlled')
    return deny('Managed tenants must never receive UAT.')
  if(stage==='live'){
    if(allowLive!==true||gates.productionWaveOpen!==true)
      return deny('Protected Production wave approval and explicit Live enablement required.')
    if(tenant.mode==='hi5_managed'){
      const qa=gates.platformTest
      const qaTime=parsedDate(qa?.passedAt)
      const delay=Number(release.managedDelayMinutes)
      if(qa?.sha!==sha||qa?.state!=='passed'||qa?.humanApproved!==true
        ||!Number.isInteger(qa.passedCanaryCount)||qa.passedCanaryCount<2
        ||!qaTime||qaTime>at
        ||!Number.isInteger(delay)||delay<0||delay>43200
        ||at.getTime()<qaTime.getTime()+delay*60000)
        return deny('Managed Live requires the real Test canary sign-off and soak, never customer UAT.')
    }else{
      const done=completedFor(gates.uat,sha)
      const approval=tenant.uatAcceptance
      const acceptedAt=parsedDate(approval?.approvedAt)
      if(!done||done>at||approval?.sha!==sha||approval?.approved!==true
        ||typeof approval.approvedBy!=='string'||!approval.approvedBy.trim()
        ||!acceptedAt||acceptedAt<done||acceptedAt>at)
        return deny('Custom Live requires exact-release UAT completion and tenant-admin approval.')
    }
  }
  const compare=routeCutoverPrecondition({
    plan,activeManifestSha256:gatewayObservedSha256,
    leaseFence:job.lease_fence,
  })
  if(!compare.allowed)return deny(compare.reason)
  if(plan.activationAllowed!==false)
    return deny('Only an immutable read-only preview may be submitted.')
  if(plan.targetRoute?.buildSha!==sha||plan.targetRoute?.host!==plan.hostname)
    return deny('Final tenant hostname or immutable release differs from approved plan.')
  return {allowed:true,stage,tenantId:tenant.id,buildSha:sha,
    leaseFence:job.lease_fence,windowEndsAt:window.endsAt,
    beforeSha256:plan.previousManifestSha256,
    afterSha256:plan.targetManifestSha256,
    reason:'Final checks passed. A separately authorised host controller may attempt the route change.'}
}
