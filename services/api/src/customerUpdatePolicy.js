// Customer application/web release policy. A policy is a preference, never
// an instruction to deploy or copy customer data without the release gates.
const DAYS=['mon','tue','wed','thu','fri','sat','sun']
const TIME=/^([01]\d|2[0-3]):([0-5]\d)$/
const ZONES=['Europe/London','Europe/Dublin','UTC','America/New_York','America/Chicago','America/Los_Angeles','Europe/Paris','Europe/Berlin','Asia/Dubai','Asia/Singapore','Australia/Sydney']
export function customerUpdateMode(input) {
  const value=String(input||'').trim()
  return value==='hi5_managed'||value==='admin_controlled'?value:null
}
export function parseCustomerUpdatePolicy(body,{requireChoice=true}={}) {
  const mode=customerUpdateMode(body?.updateMode)
  if(!mode) {
    if(requireChoice)throw new Error('Choose Managed or Custom platform updates.')
    return null
  }
  const isManaged=mode==='hi5_managed'
  const optIn=body?.customerUatOptIn===true
  const day=String(body?.deploymentDay||'sun').toLowerCase()
  const time=String(body?.deploymentTime||'02:00')
  const timezone=String(body?.deploymentTimezone||'Europe/London')
  if(isManaged && (!DAYS.includes(day)||!TIME.test(time)||!ZONES.includes(timezone)))
    throw new Error('Choose a valid deployment day, 24-hour time and supported timezone.')
  const [hours,minutes]=time.split(':').map(Number)
  const endTotal=((hours*60+minutes+120)%(24*60))
  const end=`${String(Math.floor(endTotal/60)).padStart(2,'0')}:${String(endTotal%60).padStart(2,'0')}`
  return {
    updateMode:mode,
    customerUatOptIn:isManaged?optIn:true,
    customerUatRequired:!isManaged,
    maintenanceWindow:isManaged
      ? {timezone,days:[day],start:time,end}
      : {timezone:'Europe/London',days:[],start:'02:00',end:'05:00'},
    // Manual UAT must *never* be queued for an automatic Production promotion.
    uatAutoStage:false,
    liveAutoPromote:isManaged,
    // Managed deliveries must still pass Hi5Central's own release gates.
    liveDelayHours:24,
    allowEmergencySecurityUpdates:true,
  }
}
export function customerUpdateWriteParams(tenantId,policy,updatedBy=null){
  return [tenantId,policy.updateMode,policy.uatAutoStage,
    policy.liveAutoPromote,policy.liveDelayHours,
    policy.allowEmergencySecurityUpdates,
    JSON.stringify(policy.maintenanceWindow),policy.customerUatOptIn,updatedBy]
}
export const CUSTOMER_UPDATE_UPSERT=`
  INSERT INTO tenant_release_preferences
    (tenant_id,update_mode,test_auto_sync,uat_auto_stage,live_auto_promote,
     live_delay_hours,allow_emergency_security_updates,maintenance_window,
     customer_uat_opt_in,updated_by)
  VALUES($1,$2,true,$3,$4,$5,$6,$7::jsonb,$8,$9)
  ON CONFLICT (tenant_id) DO UPDATE SET
    update_mode=EXCLUDED.update_mode,
    test_auto_sync=true,
    uat_auto_stage=EXCLUDED.uat_auto_stage,
    live_auto_promote=EXCLUDED.live_auto_promote,
    live_delay_hours=EXCLUDED.live_delay_hours,
    allow_emergency_security_updates=EXCLUDED.allow_emergency_security_updates,
    maintenance_window=EXCLUDED.maintenance_window,
    customer_uat_opt_in=EXCLUDED.customer_uat_opt_in,
    onboarding_selection_pending=false,
    updated_by=EXCLUDED.updated_by,updated_at=now()
  RETURNING *`

// Called only from the authenticated onboarding step. UAT requests are
// operator-reviewed reservations and must NEVER provision runtime/DNS.
export async function saveOnboardingUpdatePolicy(db,tenantId,policy,userId){
  await db.query(CUSTOMER_UPDATE_UPSERT,
    customerUpdateWriteParams(tenantId,policy,userId))
  if(policy.customerUatOptIn){
    await db.query(`INSERT INTO tenant_environment_provision_requests
      (tenant_id,environment,requested_by)
      SELECT $1,'uat',$2 FROM tenant_environment_instances
      WHERE tenant_id=$1 AND environment='uat'
      AND NOT EXISTS(
        SELECT 1 FROM tenant_environment_provision_requests
        WHERE tenant_id=$1 AND environment='uat'
          AND state IN ('requested','claimed','completed'))
      ON CONFLICT (tenant_id,environment)
        WHERE state IN ('requested','claimed') DO NOTHING`,[tenantId,userId])
  }else{
    const claimed=await db.query(`SELECT 1 FROM tenant_environment_provision_requests
      WHERE tenant_id=$1 AND environment='uat' AND state='claimed'
      LIMIT 1 FOR UPDATE`,[tenantId])
    if(claimed.rowCount)
      throw new Error('An operator has already claimed the UAT request. Contact support before disabling UAT.')
    await db.query(`UPDATE tenant_environment_provision_requests
      SET state='cancelled',updated_at=now()
      WHERE tenant_id=$1 AND environment='uat' AND state='requested'`,[tenantId])
  }
}
