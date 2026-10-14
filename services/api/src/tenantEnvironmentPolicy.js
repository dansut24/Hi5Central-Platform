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
