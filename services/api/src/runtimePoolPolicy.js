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
export function tenantReleaseEligibility({preference,pool,environment,uatAccepted=false,uatAcceptedAt=null,published=false,now=new Date()}){
  if(!preference||!['admin_controlled','hi5_managed'].includes(preference.update_mode))
    return {state:'blocked',reason:'Tenant has no valid update preference.'}
  if(!['uat','live'].includes(environment))
    return {state:'blocked',reason:'Only UAT and Live can receive customer release assignments.'}
  if(!published)return {state:'unreleased',reason:'Hi5Central has not published this application version.'}
  const verified=verifiedRuntimePool(pool,now)
  if(!verified.verified||pool.environment!==environment)
    return {state:'waiting_for_pool',reason:verified.reason||'No matching verified pool for this environment.'}
  if(preference.update_mode==='admin_controlled'){
    if(environment==='uat')return {state:'available_in_uat',reason:'Customer can begin UAT testing.'}
    return uatAccepted?{state:'ready_for_customer_approval',reason:'Customer can schedule an approved Production release.'}
      :{state:'awaiting_uat',reason:'Customer UAT acceptance must precede Production.'}
  }
  if(environment==='uat')return {state:'auto_stage_ready',reason:'Managed tenant UAT candidate may be staged.'}
  if(!uatAccepted)return {state:'awaiting_uat',reason:'Managed release requires completed UAT acceptance.'}
  const minHours=Number(preference.live_delay_hours??24)
  if(!Number.isInteger(minHours)||minHours<0||minHours>720)
    return {state:'blocked',reason:'Invalid minimum release delay.'}
  const acceptedTime=new Date(uatAcceptedAt||'').getTime()
  if(!Number.isFinite(acceptedTime)||acceptedTime>now.getTime())
    return {state:'blocked',reason:'Managed UAT approval timestamp is unavailable or in the future.'}
  if(now.getTime()-acceptedTime<minHours*60*60*1000)
    return {state:'pending_delay',reason:'Minimum managed release delay has not elapsed.'}
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
