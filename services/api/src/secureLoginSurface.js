import { portalRequestFromHeaders } from './deploymentConfig.js'

// A customer Portal login must issue a Portal session, not an ITSM staff
// workspace session. The origin is validated against the tenant separately.
export function secureLoginSurface(origin = '', referer = '') {
  return portalRequestFromHeaders(origin, referer) ? 'portal' : 'workspace'
}
