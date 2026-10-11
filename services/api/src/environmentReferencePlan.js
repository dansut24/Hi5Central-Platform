import {createHash} from 'node:crypto'

// Only non-secret, non-operational reference fields. No account credentials,
// access grants, session state, customer content or live agent controls.
export const REFERENCE_RESOURCES=Object.freeze([
  {kind:'people',table:'organisation_people',fields:['name','phone','job_title','active']},
  {kind:'departments',table:'organisation_departments',fields:['name','description','active']},
  {kind:'teams',table:'organisation_teams',fields:['name','description','colour','active']},
  {kind:'sites',table:'organisation_sites',
    fields:['name','type','address_line1','city','postcode','country','timezone','active']},
])
export const MAX_RESOURCE_ROWS=1000
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const digestReferenceValue=value=>hash(value)

// Record keys are meaningful only within a verified tenant. Never use record
// IDs from Live as destination IDs: sandbox IDs may be different.
export function planReferenceChanges({source,target,baselines,resource}){
  if(!REFERENCE_RESOURCES.some(x=>x.kind===resource.kind))
    throw Error('Unregistered reference resource.')
  const byKey=new Map()
  for(const row of target){
    if(typeof row.external_key!=='string'||!row.external_key||byKey.has(row.external_key))
      throw Error('Duplicate or missing destination reference key.')
    byKey.set(row.external_key,row)
  }
  const states=new Map()
  for(const r of baselines)states.set(r.external_key+'\u0000'+r.field_key,r)
  const changes=[]
  let missing=0,conflicts=0,initialised=0,updates=0
  const sourceKeys=new Set()
  for(const row of source){
    if(typeof row.external_key!=='string'||!row.external_key||sourceKeys.has(row.external_key))
      throw Error('Duplicate or missing source reference key.')
    sourceKeys.add(row.external_key)
    const dest=byKey.get(row.external_key)
    if(!dest){missing++;continue}
    for(const field of resource.fields){
      const newHash=digestReferenceValue(row[field])
      const targetHash=digestReferenceValue(dest[field])
      const previous=states.get(row.external_key+'\u0000'+field)
      let action
      if(!previous){
        action=newHash===targetHash?'baseline':'conflict'
      }else if(newHash===targetHash){
        action=previous.source_digest===newHash&&previous.target_digest===targetHash?'unchanged':'baseline'
      }else if(previous.target_digest===targetHash){
        action='update'
      }else{
        action='conflict'
      }
      if(action==='conflict')conflicts++
      if(action==='baseline')initialised++
      if(action==='update')updates++
      if(action==='unchanged')continue
      changes.push({
        kind:resource.kind,table:resource.table,field,externalKey:row.external_key,
        // Internal-only value: never include in API summaries or journals.
        value:row[field],sourceDigest:newHash,targetDigest:targetHash,
        action,
      })
    }
  }
  return {changes,stats:{
    sourceRecords:source.length,destinationRecords:target.length,
    missing,conflicts,initialised,updates,
    destinationOnly:[...byKey.keys()].filter(k=>!sourceKeys.has(k)).length,
  }}
}
export function safeSyncSummary(plan){
  return {kind:plan.changes[0]?.kind||'',...plan.stats}
}
