import {isValidCustomerSlug} from './tenantEnvironmentHostnames.js'
const MAX_NAME=120
const emailValue=value=>String(value||'').trim().toLowerCase()
const emailValid=value=>value.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
export function validateManagedSignupRequest(body){
  const slug=String(body?.tenantSlug||'').trim().toLowerCase()
  const companyName=String(body?.companyName||'').trim()
  const ownerName=String(body?.name||'').trim()
  const ownerEmail=emailValue(body?.email)
  if(!isValidCustomerSlug(slug))throw new Error('Select a valid customer URL without reserved endings.')
  if(companyName.length<2||companyName.length>MAX_NAME)throw new Error('Company name must be 2–120 characters.')
  if(ownerName.length<2||ownerName.length>MAX_NAME)throw new Error('Enter a valid owner name.')
  if(!emailValid(ownerEmail))throw new Error('Enter a valid owner email.')
  const modules={itsm:body?.modules?.itsm!==false,selfService:body?.modules?.itsm!==false,
    rmm:body?.modules?.rmm===true}
  if(!modules.itsm&&!modules.rmm)throw new Error('Select at least one product.')
  for(const key of ['updateMode','customerUatOptIn','deploymentDay','deploymentTime','deploymentTimezone','maintenanceWindow']){
    if(Object.hasOwn(body||{},key))throw new Error('Update management is selected during customer onboarding, not signup.')
  }
  if(String(body?.website||''))throw new Error('Invalid request.')
  return {slug,companyName,ownerName,ownerEmail,modules}
}

/**
 * Fail-closed public signup scope: Production is test-recipient-only until
 * its abuse controls are separately reviewed. The previous isolated
 * canary is retained for backwards compatibility, never inferred.
 */
export function approvedManagedSignupRuntime(env={},config={}){
  const scoped=env.MANAGED_SIGNUP_LIVE_APPROVED==='true'
    ? env.MANAGED_SIGNUP_TEST_ONLY==='true'
      && Boolean(String(env.MANAGED_SIGNUP_TEST_EMAIL||'').trim())
      && config.apiUrl==='https://api.hi5central.com'
      && config.adminUrl==='https://admin.hi5central.com'
    : config.apiUrl==='https://pilot-control-api.hi5central.com'
      && config.adminUrl==='https://pilot-admin.hi5central.com'
  return env.MANAGED_SIGNUP_REQUESTS_ENABLED==='true'
    && env.DEPLOYMENT_MODE==='managed'
    && env.TENANCY_MODE==='multi'
    && config.runtimeEnvironment==='live'
    && config.rootDomain==='hi5central.com'
    && scoped
}
