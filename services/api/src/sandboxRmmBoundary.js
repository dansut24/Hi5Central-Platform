import { deployment } from './deploymentConfig.js'

/**
 * RMM owns a single Live control plane. ITSM Test and UAT are never allowed
 * to enroll real endpoints or operate inventory, patching, scripts or sessions.
 * This gate covers all /api/v1/rmm and /api/v1/agent HTTP routes (not just
 * today's remote handlers), including future routes under those namespaces.
 */
export function sandboxRmmBlocked(environment,path) {
  return (environment==='test'||environment==='uat') &&
    /^\/api\/v1\/(?:rmm|agent)(?:\/|$)/i.test(String(path||''))
}

export function createSandboxRmmGuard(environment=deployment.runtimeEnvironment) {
  return async(c,next)=>{
    if(sandboxRmmBlocked(environment,c.req.path)) {
      return c.json({error:'RMM operates only in the Live tenant. ITSM Test/UAT cannot access managed devices or agent services.'},403)
    }
    return next()
  }
}
