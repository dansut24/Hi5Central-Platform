/** The tenant's Organisation timezone, chosen at onboarding or edited in
 * Organisation Settings, is the sole source for application release windows.
 * Never take a timezone from the platform-wide release defaults or browser.
 */
const fail=message=>Object.assign(new Error(message),{status:409})

export function validOrganisationTimezone(value){
  if(typeof value!=='string'||!value.trim()||value.length>100)return null
  const timezone=value.trim()
  try{
    return new Intl.DateTimeFormat('en-GB',{timeZone:timezone}).resolvedOptions().timeZone||null
  }catch{return null}
}

export function tenantOrganisationTimezone(settings,releasePreference=null){
  const configuration=settings?.configuration?.company?.timezone
  const onboarding=settings?.onboarding_data?.company?.timezone
  // An older tenant might have a stored release timezone but lack modern
  // company onboarding fields. Use it only as a legacy fallback.
  const candidates=[configuration,onboarding,releasePreference?.maintenance_window?.timezone]
  for(const candidate of candidates){
    const timezone=validOrganisationTimezone(candidate)
    if(timezone)return timezone
  }
  throw fail('Set a valid organisation time zone in Settings → Organisation before changing maintenance hours.')
}

export function withOrganisationReleaseTimezone(window,timezone){
  const canonical=validOrganisationTimezone(timezone)
  if(!canonical)throw fail('Organisation time zone is invalid; update Settings → Organisation.')
  if(!window||typeof window!=='object'||Array.isArray(window))
    throw fail('A maintenance window is required.')
  return {...window,timezone:canonical}
}
