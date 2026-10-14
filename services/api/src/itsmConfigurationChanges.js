import { createHash } from 'node:crypto'
import { tracksItsmConfiguration } from './tenantEnvironmentPolicy.js'

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])]))
  }
  return value
}

export function itsmConfigurationHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(object(value)))).digest('hex')
}

export function itsmChangedKeys(before, after) {
  const left = object(before), right = object(after)
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => JSON.stringify(canonical(left[key])) !== JSON.stringify(canonical(right[key])))
    .sort().slice(0,100)
}

/** Save only hashes and changed key names, never secret-bearing values. */
export async function recordItsmConfigurationChange({
  db,tenantId,actorUserId,environment,before,after,
}) {
  if (!tracksItsmConfiguration(environment,'itsm')) return { recorded:false }
  const beforeHash=itsmConfigurationHash(before),afterHash=itsmConfigurationHash(after)
  if (beforeHash===afterHash) return { recorded:false }
  const changedKeys=itsmChangedKeys(before,after)
  const result=await db.query(
    'INSERT INTO itsm_configuration_change_events '+
    '(tenant_id,environment,entity_key,before_sha256,after_sha256,changed_keys,actor_user_id) '+
    'VALUES ($1,$2,$3,$4,$5,$6::text[],$7) RETURNING id,recorded_at',
    [tenantId,environment,'tenant_settings.itsm',beforeHash,afterHash,changedKeys,actorUserId],
  )
  return { recorded:true,id:result.rows[0]?.id,changedKeys }
}

export async function listItsmConfigurationChanges({
  db,tenantId,environment,limit=50,
}) {
  if (!tracksItsmConfiguration(environment,'itsm')) return []
  const size=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:50))
  const result=await db.query(
    'SELECT id,environment,entity_key AS "entityKey",before_sha256 AS "beforeHash",'+
    'after_sha256 AS "afterHash",changed_keys AS "changedKeys",'+
    'actor_user_id AS "actorUserId",recorded_at AS "recordedAt" '+
    'FROM itsm_configuration_change_events '+
    'WHERE tenant_id=$1 AND environment=$2 '+
    'ORDER BY recorded_at DESC,id DESC LIMIT $3',
    [tenantId,environment,size],
  )
  return result.rows
}
