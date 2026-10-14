// Versioned runtime rollout decisions. No routing is activated by these
// functions. Edge traffic changes require a separately attested host manifest.
export const BUILD_SHA=/^[a-f0-9]{40}$/
export const POOL_ID=/^[a-z][a-z0-9-]{2,62}$/
const POOL_OBSERVATION_MAX_AGE_MS=15*60*1000
const DAYS=['sun','mon','tue','wed','thu','fri','sat']

function timeParts(timeZone, now){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone,weekday:'short',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now)
  const value=Object.fromEntries(parts.map(part=>[part.type,part.value]))
  return {day:String(value.weekday||'').toLowerCase().slice(0,3),
    minute:Number(value.hour)*60+Number(value.minute)}
}
function toMinute(value){
  if(!/^\d{2}:\d{2}$/.test(String(value)))return null
  const [h,m]=String(value).split(':').map(Number)
  return h<=23&&m<=59?h*60+m:null
}
export function maintenanceWindowStatus(policy={},now=new Date()){
  const zone=String(policy?.timezone||'Europe/London')
  try{new Intl.DateTimeFormat('en-GB',{timeZone:zone}).format(now)}
  catch{return {allowed:false,reason:'Maintenance time zone is invalid.'}}
  const from=toMinute(policy?.start||'02:00')
  const to=toMinute(policy?.end||'05:00')
  if(from==null||to==null||from===to)
    return {allowed:false,reason:'A valid nonzero maintenance window is required.'}
  const days=Array.isArray(policy?.days)?policy.days.map(x=>String(x).toLowerCase().slice(0,3)):[]
  if(days.some(day=>!DAYS.includes(day)))
    return {allowed:false,reason:'Maintenance days are invalid.'}
  const local=timeParts(zone,now)
  const dayIndex=DAYS.indexOf(local.day)
  const dayAllowed=day=>!days.length||days.includes(day)
  let allowed
  if(from<to){
    allowed=dayAllowed(local.day)&&local.minute>=from&&local.minute<to
  }else{
    // Overnight windows belong to their start date. This prevents a wrong
    // weekday assignment just after midnight, including DST transitions.
    const yesterday=DAYS[(dayIndex+6)%7]
    allowed=(dayAllowed(local.day)&&local.minute>=from)
      ||(dayAllowed(yesterday)&&local.minute<to)
  }
  return {allowed,reason:allowed?'Inside approved maintenance window.':'Outside approved maintenance window.',
    timezone:zone,localDay:local.day}
}
export function verifiedRuntimePool(pool,now=new Date()){
  if(!pool||!POOL_ID.test(String(pool.id||''))||!BUILD_SHA.test(String(pool.build_sha||'')))
    return {verified:false,reason:'Pool identity or immutable revision is invalid.'}
  if(!['test','uat','live'].includes(pool.environment)||pool.state!=='verified')
    return {verified:false,reason:'Pool is not host-verified.'}
  if(!/^[a-z][a-z0-9-]{1,70}:[1-9]\d{1,4}$/.test(String(pool.api_target||''))
    ||!/^[a-z][a-z0-9-]{1,70}:[1-9]\d{1,4}$/.test(String(pool.web_target||'')))
    return {verified:false,reason:'Pool upstream services are not valid internal targets.'}
  const age=now.getTime()-new Date(pool.last_seen_at||pool.verified_at||'').getTime()
  if(!Number.isFinite(age)||age<0||age>POOL_OBSERVATION_MAX_AGE_MS)
    return {verified:false,reason:'Pool health attestation is stale.'}
  return {verified:true,reason:''}
}
// Managed customers have no UAT. Delay is measured from the immutable
// published release, never from a customer UAT acceptance or offer creation.
export function publishedReleaseDelayStatus(publishedAt,hours,now=new Date()){
  const stamp=new Date(publishedAt||'').getTime()
  const delay=Number(hours)
  if(!Number.isInteger(delay)||delay<0||delay>720)
    return {ready:false,invalid:true,reason:'Invalid managed rollout delay.'}
  if(!Number.isFinite(stamp)||stamp>now.getTime())
    return {ready:false,invalid:true,reason:'The published release timestamp is missing or in the future.'}
  const ready=now.getTime()-stamp>=delay*3600000
  return {ready,invalid:false,reason:ready?'Managed release delay elapsed.':'Waiting for the published release delay.'}
}

export function tenantReleaseEligibility({preference,pool,environment,uatAccepted=false,published=false,publishedAt=null,now=new Date()}){
  if(!preference||!['admin_controlled','hi5_managed'].includes(preference.update_mode))
    return {state:'blocked',reason:'Tenant has no valid update preference.'}
  if(!['uat','live'].includes(environment))
    return {state:'blocked',reason:'Only UAT and Live can receive customer release assignments.'}
  if(!published)return {state:'unreleased',reason:'Hi5Central has not published this application version.'}
  const verified=verifiedRuntimePool(pool,now)
  if(!verified.verified||pool.environment!==environment)
    return {state:'waiting_for_pool',reason:verified.reason||'No matching verified pool for this environment.'}
  if(preference.update_mode==='admin_controlled'){
    if(environment==='uat')return preference.uat_auto_stage===true
      ?{state:'auto_stage_ready',reason:'New published release is ready to stage automatically in customer UAT.'}
      :{state:'available_in_uat',reason:'Customer can begin UAT testing.'}
    return uatAccepted?{state:'ready_for_customer_approval',reason:'Customer can schedule an approved Production release.'}
      :{state:'awaiting_uat',reason:'Customer UAT acceptance must precede Production.'}
  }
  if(environment==='uat')
    return {state:'blocked',reason:'Hi5Central-managed customers do not have a separate UAT release stage.'}
  if(preference.live_auto_promote!==true)
    return {state:'blocked',reason:'Managed automatic updates are paused.'}
  const age=publishedReleaseDelayStatus(publishedAt,preference.live_delay_hours,now)
  if(age.invalid)return {state:'blocked',reason:age.reason}
  if(!age.ready)return {state:'pending_delay',reason:age.reason}
  const gate=maintenanceWindowStatus(preference.maintenance_window||{},now)
  return gate.allowed?{state:'eligible_for_scheduled_update',reason:'Maintenance window open; host activation still requires approval.'}
    :{state:'pending_maintenance',reason:gate.reason}
}
export function resolvedCustomerPool({assignment,pool,environment,generationActive=false,now=new Date()}){
  if(!assignment)return {route:'legacy',reason:'No explicit pool assignment; existing stable runtime remains active.'}
  if(assignment.environment!==environment||!generationActive)
    return {route:'blocked',reason:'Route generation is not active for this environment.'}
  if(!pool||assignment.pool_id!==pool.id||assignment.build_sha!==pool.build_sha
    ||pool.environment!==environment)
    return {route:'blocked',reason:'Tenant assignment and host pool attestation do not match.'}
  const verified=verifiedRuntimePool(pool,now)
  return verified.verified?{route:'pool',poolId:pool.id,buildSha:pool.build_sha}
    :{route:'blocked',reason:verified.reason}
}
export function customerPoolHostname(slug,environment,domain='hi5central.com'){
  if(!/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/.test(slug)
    ||!['uat','live'].includes(environment)||!/^[a-z0-9.-]+$/.test(domain))
    throw Error('Invalid tenant hostname for pool routing.')
  return (environment==='uat'?slug+'-uat':slug)+'.'+domain
}
