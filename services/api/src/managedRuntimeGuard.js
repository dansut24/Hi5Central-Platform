// A managed UAT/Test runtime must never start an HTTP listener or an RMM
// command broker against a database with no explicit operator attestation.
// Internal Dev, Production and self-hosted editions are not affected.
export function needsManagedRuntimeAttestation(config) {
  return config.deploymentMode === 'managed'
    && config.tenancyMode === 'multi'
    && ['uat','test'].includes(config.runtimeEnvironment)
}

export function validateRuntimeAttestation(config, identity) {
  if (!needsManagedRuntimeAttestation(config)) return { allowed:true, required:false }
  const errors=[]
  if (!identity) errors.push('Target database has no operator-attested identity.')
  else {
    if (identity.environment !== config.runtimeEnvironment) errors.push('Database belongs to a different environment.')
    if (identity.root_domain !== config.rootDomain) errors.push('Database root domain mismatch.')
    if (!identity.instance_id) errors.push('Database instance identifier is missing.')
    if (!String(identity.verified_by||'').trim()) errors.push('Operator verification is missing.')
    if (!identity.verified_at) errors.push('Verification timestamp is missing.')
  }
  return { allowed:errors.length===0, required:true, errors }
}

export async function assertManagedRuntimeAttestation(pool,config) {
  if (!needsManagedRuntimeAttestation(config)) return
  let identity
  try {
    const result=await pool.query(
      `SELECT environment,root_domain,instance_id,verified_by,verified_at
         FROM managed_runtime_database_identity WHERE singleton=true`,
    )
    identity=result.rows[0]||null
  } catch (error) {
    throw new Error('Managed customer runtime cannot start: database attestation schema unavailable.',{cause:error})
  }
  const report=validateRuntimeAttestation(config,identity)
  if (!report.allowed) {
    throw new Error(`Managed customer runtime startup blocked: ${report.errors.join(' ')}`)
  }
  return identity
}

/**
 * Operator-attested Redis binding for an isolated managed sandbox.
 * Provisioning must establish the binding out-of-band, after checking that
 * UAT/Test do not share the Production Redis instance, credentials or queues.
 * The application deliberately never creates or repairs the binding.
 */
export const MANAGED_RUNTIME_REDIS_IDENTITY_KEY = 'hi5central:managed:runtime:identity'

export function validateManagedRuntimeRedisIdentity(config, databaseIdentity, identity) {
  if (!needsManagedRuntimeAttestation(config)) return { allowed: true, required: false, errors: [] }
  const errors = []
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return { allowed: false, required: true, errors: ['Redis has no operator-attested runtime identity.'] }
  }
  if (identity.environment !== config.runtimeEnvironment) errors.push('Redis environment does not match API runtime.')
  if (identity.rootDomain !== config.rootDomain) errors.push('Redis root domain does not match API runtime.')
  if (String(identity.databaseInstanceId || '').toLowerCase() !== String(databaseIdentity?.instance_id || '').toLowerCase()) {
    errors.push('Redis is not bound to the attested PostgreSQL database instance.')
  }
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(identity.redisInstanceId || ''))) {
    errors.push('Redis instance identifier is missing or invalid.')
  }
  if (!String(identity.verifiedBy || '').trim() || !identity.verifiedAt
      || !Number.isFinite(new Date(identity.verifiedAt).getTime())) {
    errors.push('Redis operator verification is incomplete.')
  }
  return { allowed: errors.length === 0, required: true, errors }
}

export async function assertManagedRuntimeRedisAttestation(redisClient, config, databaseIdentity) {
  if (!needsManagedRuntimeAttestation(config)) return
  let identity
  try {
    const value = await redisClient.get(MANAGED_RUNTIME_REDIS_IDENTITY_KEY)
    identity = value ? JSON.parse(value) : null
  } catch (error) {
    throw new Error('Managed customer runtime cannot start: Redis attestation is unreadable.', { cause: error })
  }
  const report = validateManagedRuntimeRedisIdentity(config, databaseIdentity, identity)
  if (!report.allowed) throw new Error(`Managed customer runtime startup blocked: ${report.errors.join(' ')}`)
}
