/** Shared server-side constraints for explicitly selected ITSM release windows. */
export const RELEASE_MAINTENANCE_DAYS=Object.freeze(['mon','tue','wed','thu','fri','sat','sun'])
const CLOCK=/^(?:[01]\d|2[0-3]):[0-5]\d$/
const error=msg=>Object.assign(new Error(msg),{status:400})
function minutes(hhmm){const [h,m]=hhmm.split(':').map(Number);return h*60+m}
/**
 * Fail closed: an update window must be chosen explicitly by the customer.
 * This value controls the real certified-release scheduler, not RMM patching.
 */
export function validateOnboardingMaintenanceWindow(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))
  throw error('Choose your application release maintenance window before continuing.')
 const days=raw.days
 if(!Array.isArray(days)||days.length<1||days.length>7
    ||new Set(days).size!==days.length
    ||days.some(d=>!RELEASE_MAINTENANCE_DAYS.includes(d)))
  throw error('Select at least one valid maintenance weekday.')
 const {start,end,timezone}=raw
 if(!CLOCK.test(String(start))||!CLOCK.test(String(end)))
  throw error('Enter valid 24-hour maintenance start and end times.')
 const duration=(minutes(end)-minutes(start)+1440)%1440
 if(duration<30)throw error('Choose a maintenance window of at least 30 minutes.')
 if(typeof timezone!=='string'||timezone.length<3||timezone.length>100)
  throw error('Select a valid IANA maintenance timezone.')
 try{
  const canonical=new Intl.DateTimeFormat('en-GB',{timeZone:timezone}).resolvedOptions().timeZone
  if(!canonical)throw Error('Invalid IANA timezone')
 }catch{throw error('Select a valid IANA timezone, for example Europe/London.')}
 return {days:RELEASE_MAINTENANCE_DAYS.filter(d=>days.includes(d)),start,end,timezone}
}
