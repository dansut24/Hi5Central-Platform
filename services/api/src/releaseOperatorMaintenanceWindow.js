import {maintenanceWindowStatus} from './runtimePoolPolicy.js'

/**
 * Legacy release-operator approval uses the same IANA-aware policy as the
 * certified scheduler and fenced tenant worker. A missing or empty day list
 * MUST NOT accidentally authorise unrestricted deployment.
 *
 * Overnight windows belong to the weekday on which they start. For example,
 * Saturday 22:00–Sunday 03:00 with ['sat'] permits 01:00 Sunday, whereas
 * ['sun'] does not permit it until Sunday 22:00.
 */
export function operatorMaintenanceWindowAllowed(policy,now=new Date()){
 if(!policy||typeof policy!=='object'||Array.isArray(policy)
  ||typeof policy.timezone!=='string'||!policy.timezone.trim()
  ||!Array.isArray(policy.days)||policy.days.length===0)
  return false
 return maintenanceWindowStatus(policy,now).allowed===true
}
