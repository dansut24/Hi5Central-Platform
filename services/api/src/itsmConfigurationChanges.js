import { createHash } from 'node:crypto'
import { tracksItsmConfiguration } from './tenantEnvironmentPolicy.js'
import { itsmAuditValueChanges } from './itsmAuditValueDisplay.js'

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

/**
 * Apply only requested leaf changes to the LOCKED, persisted ITSM config.
 * Client-side defaults are presentation data, not audited changes. This also
 * avoids replacing unrelated persisted settings from another editor/session.
 *
 * Do not accept object snapshots or user-selected audit keys: the server
 * derives actual changed paths after validating each leaf.
 */
export function applyItsmSettingsEdits(before,changes) {
  if(!Array.isArray(changes)||changes.length>100)
    throw new Error('ITSM settings changes must be a list of at most 100 edits.')
  const result=structuredClone(object(before))
  const changedPaths=[]
  const seen=new Set()
  for(const change of changes) {
    const path=change?.path
    const value=change?.value
    if(!Array.isArray(path)||path.length<1||path.length>6
      ||path.some(part=>typeof part!=='string'
        || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(part)
        || ['__proto__','constructor','prototype'].includes(part)))
      throw new Error('Invalid ITSM settings path.')
    if(value!==null&&!['string','number','boolean'].includes(typeof value)
      ||typeof value==='string'&&value.length>2000
      ||typeof value==='number'&&!Number.isFinite(value))
      throw new Error('Invalid ITSM settings value.')
    const id=path.join('.')
    if(seen.has(id)||[...seen].some(existing=>existing.startsWith(id+'.')||id.startsWith(existing+'.')))
      throw new Error('Duplicate or overlapping ITSM settings edits.')
    seen.add(id)
    let parent=result
    for(const part of path.slice(0,-1)) {
      if(parent[part]===undefined)parent[part]={}
      if(!parent[part]||typeof parent[part]!=='object'||Array.isArray(parent[part]))
        throw new Error('Cannot update a nested field beneath a scalar setting.')
      parent=parent[part]
    }
    const last=path[path.length-1]
    if(JSON.stringify(canonical(parent[last]))!==JSON.stringify(canonical(value))) {
      parent[last]=value
      changedPaths.push(id)
    }
  }
  return {configuration:result,changedPaths:changedPaths.sort()}
}

/** Save only hashes and changed key names, never secret-bearing values. */
export async function recordItsmConfigurationChange({
  db,tenantId,actorUserId,environment,before,after,changedPaths=null,
}) {
  if (!tracksItsmConfiguration(environment,'itsm')) return { recorded:false }
  const beforeHash=itsmConfigurationHash(before),afterHash=itsmConfigurationHash(after)
  if (beforeHash===afterHash) return { recorded:false }
  const changedKeys=changedPaths===null?itsmChangedKeys(before,after):changedPaths
  // Only delta-v2 leaf edits are eligible. Legacy snapshot comparisons
  // cannot safely identify actual edited values.
  const valueChanges=changedPaths===null?[]:itsmAuditValueChanges(before,after,changedPaths)
  const result=await db.query(
    'INSERT INTO itsm_configuration_change_events '+
    '(tenant_id,environment,entity_key,before_sha256,after_sha256,changed_keys,actor_user_id,value_changes,recorded_at) '+
    'VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8::jsonb,clock_timestamp()) RETURNING id,recorded_at',
    [tenantId,environment,changedPaths===null?'tenant_settings.itsm':'tenant_settings.itsm.delta-v2',beforeHash,afterHash,changedKeys,actorUserId,JSON.stringify(valueChanges)],
  )
  return { recorded:true,id:result.rows[0]?.id,changedKeys,valueChanges }
}

export async function listItsmConfigurationChanges({
  db,tenantId,environment,limit=50,
}) {
  if (!tracksItsmConfiguration(environment,'itsm')) return []
  const size=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:50))
  const result=await db.query(
    'SELECT id,environment,entity_key AS "entityKey",before_sha256 AS "beforeHash",'+
    'after_sha256 AS "afterHash",changed_keys AS "changedKeys",'+
    'value_changes AS "valueChanges",'+
    'actor_user_id AS "actorUserId",recorded_at AS "recordedAt" '+
    'FROM itsm_configuration_change_events '+
    'WHERE tenant_id=$1 AND environment=$2 '+
    'ORDER BY recorded_at DESC,id DESC LIMIT $3',
    [tenantId,environment,size],
  )
  return result.rows
}
