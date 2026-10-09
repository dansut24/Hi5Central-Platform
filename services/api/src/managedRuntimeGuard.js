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
}
