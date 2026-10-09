/**
 * No managed UAT/Test tenant can sign up or enrol Agents until an independently
 * reviewed activation mechanism exists. The identity-preparation worker only
 * creates suspended tenants: never infer readiness from a hostname or status.
 */
export function isManagedCustomerSandbox(config) {
  return config?.deploymentMode === 'managed'
    && config?.tenancyMode === 'multi'
    && (config?.runtimeEnvironment === 'uat' || config?.runtimeEnvironment === 'test')
}

export function managedSandboxRequiresMfa(config) {
  return isManagedCustomerSandbox(config)
}

export function managedSandboxBlocksPublicSignup(config) {
  return isManagedCustomerSandbox(config)
}

export function managedSandboxBlocksRmm(config) {
  return isManagedCustomerSandbox(config)
}
