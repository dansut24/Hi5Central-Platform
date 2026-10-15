import {maintenanceWindowStatus} from './runtimePoolPolicy.js'

const SHA=/^[a-f0-9]{40}$/
const DAY_MINUTES=1440
const DAY_MS=86400000
const DEFAULT_START_DELAY_MINUTES=5
const MAX_SEARCH_DAYS=35
const STEP_MS=5*60000
const STAGES=['test','uat','live']

const validDate=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date:null}
const mins=value=>{if(!/^\d{2}:\d{2}$/.test(String(value||'')))return NaN;const [h,m]=value.split(':').map(Number);return h<24&&m<60?h*60+m:NaN}
const absoluteWindowLength=policy=>{
  const start=mins(policy?.start),end=mins(policy?.end)
  if(!Number.isFinite(start)||!Number.isFinite(end)||start===end)return 0
  return (end-start+DAY_MINUTES)%DAY_MINUTES
}
const blockAt=(blocks,at,end)=>{
  for(const value of blocks||[]){
    const begin=validDate(value?.startsAt),finish=validDate(value?.endsAt)
    if(!begin||!finish||finish<=begin)return {invalid:true}
    if(at<finish&&end>begin)return {blocked:true}
  }
  return {blocked:false}
}

/**
 * Re-evaluate the tenant's *entire remaining cutover duration* at the instant
 * a worker claims a job. A start-time-only gate could cross a window end or
 * customer blackout. No caller may rely solely on the original queued time.
 */
export function activeTenantMaintenanceWindow({
  policy,now=new Date(),durationMinutes=15,blackouts=[]
}={}){
  const fail=reason=>({allowed:false,reason})
  const at=validDate(now)
  if(!at)return fail('Invalid current time.')
  if(!policy?.timezone||!Array.isArray(policy.days)||!policy.days.length
    ||!Number.isInteger(durationMinutes)||durationMinutes<1||durationMinutes>240)
    return fail('Explicit maintenance policy and bounded duration are required.')
  if(absoluteWindowLength(policy)<Math.max(30,durationMinutes))
    return fail('Configured maintenance window is too short.')
  const endExclusive=new Date(at.getTime()+durationMinutes*60000)
  const first=maintenanceWindowStatus(policy,at)
  const last=maintenanceWindowStatus(policy,new Date(endExclusive.getTime()-1))
  if(!first.allowed||!last.allowed)
    return fail(!first.allowed?first.reason:'Insufficient time remaining in the maintenance window.')
  if(!Array.isArray(blackouts))
    return fail('Customer blackout configuration must be an array.')
  const overlap=blockAt(blackouts,at,endExclusive)
  if(overlap.invalid)return fail('Invalid customer blackout range.')
  if(overlap.blocked)return fail('Cutover overlaps a customer blackout period.')
  return {allowed:true,reason:'Full cutover fits the approved window with no blackout.',
    startsAt:at.toISOString(),endsAt:endExclusive.toISOString()}
}

/**
 * Returns a UTC instant inside an explicitly configured IANA-timezone window.
 * Scan in UTC (not arithmetic on wall-clock timestamps) so spring-forward gaps
 * cannot be scheduled and repeated autumn times map to actual UTC instants.
 * The 5-minute search probes are refined minute-by-minute at the first match.
 */
export function nextTenantMaintenanceWindow({
  policy,now=new Date(),notBefore=now,durationMinutes=15,blackouts=[],
  searchDays=MAX_SEARCH_DAYS,minLeadMinutes=DEFAULT_START_DELAY_MINUTES,
}={}){
  const fail=reason=>({ok:false,reason})
  if(!policy||!policy.timezone||!Array.isArray(policy.days)||!policy.days.length)
    return fail('An explicit timezone and selected maintenance weekdays are required.')
  if(!Number.isInteger(durationMinutes)||durationMinutes<1||durationMinutes>240
    ||!Number.isInteger(minLeadMinutes)||minLeadMinutes<0
    ||!Number.isInteger(searchDays)||searchDays<1||searchDays>MAX_SEARCH_DAYS)
    return fail('Invalid requested duration or scheduling horizon.')
  if(absoluteWindowLength(policy)<Math.max(30,durationMinutes))
    return fail('Maintenance window is too short for a safe deployment.')
  const current=validDate(now),earliest=validDate(notBefore)
  if(!current||!earliest)return fail('Invalid scheduling date.')
  const start= Math.ceil(Math.max(current.getTime()+minLeadMinutes*60000,
    earliest.getTime())/60000)*60000
  const stop=current.getTime()+searchDays*DAY_MS
  const eligible=t=>{
    const end=new Date(t+durationMinutes*60000-1)
    if(!maintenanceWindowStatus(policy,new Date(t)).allowed
      ||!maintenanceWindowStatus(policy,end).allowed)return false
    const blackout=blockAt(blackouts,new Date(t),end)
    return !blackout.invalid&&!blackout.blocked
  }
  if((blackouts||[]).some(b=>!validDate(b?.startsAt)||!validDate(b?.endsAt)
     ||new Date(b.endsAt)<=new Date(b.startsAt)))return fail('A blackout period is invalid.')
  if(eligible(start))return {ok:true,scheduledAt:new Date(start).toISOString()}
  for(let t=start+STEP_MS;t<stop;t+=STEP_MS){
    if(!eligible(t))continue
    for(let candidate=Math.max(start,t-STEP_MS+60000);candidate<=t;candidate+=60000)
      if(eligible(candidate))return {ok:true,scheduledAt:new Date(candidate).toISOString()}
  }
  return fail('No maintenance window available within the scheduling horizon.')
}

/**
 * Pure, side-effect-free plan for one tenant. A plan cannot activate a route,
 * create a Docker container, or bypass shared wave safety gates.
 */
export function planTenantRelease({tenant,release,gates={},now=new Date()}={}){
  const block=(stage,reason)=>({tenantId:tenant?.id||null,mode:tenant?.mode||null,
    stage,status:'blocked',reason,buildSha:release?.sha||null})
  const sha=release?.sha
  if(!SHA.test(String(sha||''))||release?.published!==true
    ||release?.humanApproved!==true||release?.ciPassed!==true
    ||release?.migrationCompatible!==true||release?.securityPassed!==true)
    return block('test','Exact published, human-approved, CI/security/compatibility-cleared release required.')
  if(!tenant?.id||!['hi5_managed','admin_controlled'].includes(tenant.mode)
     ||tenant.itsm!==true||tenant.status!=='active')
    return block('test','Tenant must have active ITSM and a valid Managed/Custom update policy.')
  if(!tenant.maintenance?.timezone||!tenant.maintenance.days?.length)
    return block('test','Tenant maintenance policy is missing.')
  const test=gates.test
  const uat=gates.uat
  let stage='test',readyAfter=validDate(release.publishedAt)
  if(!readyAfter)return block('test','Release publication timestamp missing.')
  if(test?.sha===sha&&test.state==='succeeded'){
    const completed=validDate(test.completedAt)
    const soak=Math.max(30,Number(release.testSoakMinutes??30))
    if(!completed||!Number.isFinite(soak)||soak>10080)
      return block('test','Verified Test completion or soak policy invalid.')
    stage=tenant.mode==='admin_controlled'?'uat':'live'
    readyAfter=new Date(completed.getTime()+soak*60000)
    // The soak period contributes to the earliest schedule date. Jobs may
    // be queued ahead of time, but may never activate before it has elapsed.
    if(tenant.mode==='admin_controlled'){
      if(uat?.sha!==sha||uat.state!=='succeeded'){
        stage='uat'
      }else{
        stage='live'
        const acceptance=tenant.uatAcceptance
        if(acceptance?.sha!==sha||acceptance.approved!==true||!acceptance.approvedBy
          ||!validDate(acceptance.approvedAt))
          return block('live','Custom Production requires explicit tenant-admin approval of exact UAT release.')
        readyAfter=new Date(Math.max(readyAfter.getTime(),
          new Date(acceptance.approvedAt).getTime()))
      }
    }
  }else if(test&&test.sha===sha&&test.state==='failed'){
    return block('test','Failed Test rollout blocks downstream stages.')
  }
  if(stage==='live'){
    if(gates.platformPaused===true||gates.productionWaveOpen!==true)
      return block(stage,'Production wave is paused or not approved.')
    if(tenant.mode==='hi5_managed'){
      // Managed customers never acquire a UAT environment or UAT approval.
      const delay=Number(release.managedDelayMinutes??30)
      if(!Number.isInteger(delay)||delay<0||delay>43200)
        return block(stage,'Invalid Managed Production release delay.')
      readyAfter=new Date(readyAfter.getTime()+delay*60000)
    }
  }
  if(stage==='uat'&&tenant.mode!=='admin_controlled')
    return block(stage,'Managed tenants must never enter UAT.')
  if(gates.platformPaused===true)return block(stage,'Platform-wide pause is active.')
  const window=nextTenantMaintenanceWindow({
    policy:tenant.maintenance,now,notBefore:readyAfter,
    durationMinutes:release.expectedDeployMinutes??15,
    blackouts:tenant.blackouts||[],
  })
  if(!window.ok)return block(stage,window.reason)
  return {tenantId:tenant.id,mode:tenant.mode,stage,status:'scheduled',
    scheduledAt:window.scheduledAt,buildSha:sha,
    idempotencyKey:`${tenant.id}:${stage}:${sha}`,reason:'Awaiting host-verified activation within tenant maintenance window.'}
}

export function planReleaseCohort({tenants=[],release,gates={},now=new Date()}={}){
  if(!Array.isArray(tenants)||tenants.length>2000)
    throw Error('A bounded tenant cohort is required.')
  const ids=new Set()
  return tenants.map(tenant=>{
    if(ids.has(tenant.id))throw Error('Duplicate tenant in release cohort.')
    ids.add(tenant.id)
    return planTenantRelease({tenant,release,gates,now})
  })
}
