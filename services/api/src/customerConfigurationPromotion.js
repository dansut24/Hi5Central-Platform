// Read-only first gate for CUSTOM tenant-specific UAT -> Production configuration.
// This does not perform a promotion, send data or approve a release.
const ALLOWED_KEYS=new Set([
 'theme','itsm','rmm','groups','permissions','integrations'
])
export function inspectCustomerConfigurationPromotion({preference,uat,live,keys}={}){
  const blockers=[]
  if(preference?.onboarding_selection_pending===true)
    blockers.push('The first owner has not selected an update method during onboarding.')
  if(preference?.update_mode!=='admin_controlled')
    blockers.push('Custom/manual update mode must be selected.')
  if(preference?.customer_uat_opt_in!==true)
    blockers.push('Customer UAT is required for Custom promotions.')
  if(!uat || uat.environment!=='uat' || uat.provisioning_status!=='ready'
    || !uat.isolation_verified_at)
    blockers.push('Customer UAT is not independently activated and isolation-verified.')
  if(!live || live.environment!=='live' || live.provisioning_status!=='ready'
    || !live.isolation_verified_at)
    blockers.push('Customer Production isolation and backup readiness are not verified.')
  if(!Array.isArray(keys)||!keys.length||keys.length>6
    || new Set(keys).size!==keys.length || keys.some(key=>!ALLOWED_KEYS.has(key)))
    blockers.push('Select explicit allowlisted configuration categories; no data or secrets.')
  // Even after satisfying prerequisites, promotion execution is separately gated.
  return {eligibleForReview:blockers.length===0,eligibleForExecution:false,
    blockers,requiresIndependentApproval:true,
    excludes:['customer records','tickets','messages','credentials','MFA secrets','tokens','device inventory'],
    nextStep:blockers.length?'Resolve environment and policy prerequisites.'
      :'Capture per-key configuration diffs, tenant review and signed authorisation before applying to Production.'}
}
