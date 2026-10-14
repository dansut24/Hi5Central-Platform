/**
 * ITSM sandboxes are not RMM deployments. Live is the canonical identity,
 * billing, security and RMM authority; UAT exists only for Custom ITSM.
 */
export const SANDBOX_ENVIRONMENTS = Object.freeze(['test', 'uat'])

export function itsmEnvironmentsForMode(updateMode) {
  if (updateMode === 'hi5_managed') return ['test']
  if (updateMode === 'admin_controlled') return ['test', 'uat']
  throw new Error('Unknown tenant update policy: fail closed.')
}

export function environmentAllowed(updateMode, environment) {
  return itsmEnvironmentsForMode(updateMode).includes(environment)
}

export function sandboxModules(value) {
  const modules = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return { ...modules, rmm: false }
}

export function sandboxConfiguration(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const { rmm: _rmm, ...withoutRmm } = source
  return withoutRmm
}

export function tracksItsmConfiguration(environment, area) {
  return ['live', 'uat'].includes(environment) && area === 'itsm'
}

/**
 * One centrally enforced release policy for both signup and Admin Portal edits.
 * Managed ITSM has Test + Live (no UAT); Custom ITSM has Test + UAT + Live.
 */
export function releaseModeDefaults(updateMode) {
  if (!['hi5_managed', 'admin_controlled'].includes(updateMode)) {
    throw new Error('Unknown tenant update policy: fail closed.')
  }
  return {
    testAutoSync: true,
    uatAutoStage: updateMode === 'admin_controlled',
    liveAutoPromote: updateMode === 'hi5_managed',
  }
}
