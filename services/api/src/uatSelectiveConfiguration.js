import { safePromotableSettingValue } from './itsmAuditValueDisplay.js'
import { applyItsmSettingsEdits } from './itsmConfigurationChanges.js'

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export function validPromotionId(value){return UUID.test(String(value||''))}
export function sameSettingValue(a,b){return a===b}

/** A candidate is derived exclusively from the trusted UAT event ledger.
 * The browser may choose a pre-existing event/path but never submit values.
 */
export function evaluateUatConfigurationCandidates({events,uatConfig,liveConfig,priorPromotions=[]}) {
  const latest=new Set(),items=[]
  const prior=new Map(priorPromotions.map(p=>[p.uat_event_id+':'+p.setting_path,p]))
  for(const event of events||[]) {
    if(!validPromotionId(event.id)||event.entity_key!=='tenant_settings.itsm.delta-v2'
      ||!Array.isArray(event.value_changes))continue
    // A later UAT edit supersedes every older audit candidate, even when
    // that new edit has no safe value-summary representation.
    const newerKeys=Array.isArray(event.changed_keys)?event.changed_keys:[]
    for(const change of event.value_changes){
      const path=change?.path
      if(typeof path!=='string'||latest.has(path))continue
      const uat=safePromotableSettingValue(uatConfig,path)
      if(!uat.allowed||!uat.known||uat.kind!==change.kind)continue
      // Once a newer UAT event exists for a path, older events must never
      // become eligible, even if the user later toggles a value back.
      latest.add(path)
      const live=safePromotableSettingValue(liveConfig,path)
      const before=change.before
      const after=change.after
      const history=prior.get(event.id+':'+path)
      const uatCurrent=sameSettingValue(uat.value,after)
      let status='ready'
      if(!uatCurrent)status='superseded'
      else if(history?.status==='applied')status='promoted'
      else if(live.known&&sameSettingValue(live.value,after))status='already_applied'
      else if(before===null||!live.known)status='unknown_baseline'
      else if(!sameSettingValue(live.value,before))status='conflict'
      if(history?.status==='reverted')status='reverted'
      items.push({
        eventId:event.id,path,kind:uat.kind,before,after,
        uatValue:uat.value,liveValue:live.known?live.value:null,
        liveKnown:live.known,status,recordedAt:event.recorded_at,
        appliedAt:history?.applied_at||null,promotionId:history?.id||null,
      })
    }
    for(const key of newerKeys)if(typeof key==='string')latest.add(key)
  }
  return items
}

export function prepareSelectiveItsmPromotion({candidate,liveConfig}) {
  if(!candidate||candidate.status!=='ready') {
    const error=new Error('This UAT setting is not ready for Production promotion.')
    error.status=409;throw error
  }
  const live=safePromotableSettingValue(liveConfig,candidate.path)
  if(!live.allowed||!live.known||!sameSettingValue(live.value,candidate.before)){
    const error=new Error('Production has changed since this UAT setting was reviewed. Refresh before promoting.')
    error.status=409;throw error
  }
  const edits=[{path:candidate.path.split('.'),value:candidate.after}]
  const result=applyItsmSettingsEdits(liveConfig,edits)
  // When an effective default was not physically stored, the explicit
  // promoted value is still a real change even if the storage object is empty.
  if(result.changedPaths.length!==1) {
    const error=new Error('Production already has this value or the change is stale.')
    error.status=409;throw error
  }
  return result
}

export function prepareSelectiveItsmRevert({promotion,liveConfig}) {
  if(!promotion||promotion.status!=='applied'){
    const error=new Error('Only applied promotions can be reverted.')
    error.status=409;throw error
  }
  const current=safePromotableSettingValue(liveConfig,promotion.setting_path)
  if(!current.allowed||!current.known
    ||!sameSettingValue(current.value,promotion.after_value)){
    const error=new Error('Production has changed since promotion. A rollback would overwrite another edit.')
    error.status=409;throw error
  }
  const before=promotion.before_value
  const result=applyItsmSettingsEdits(liveConfig,[{
    path:promotion.setting_path.split('.'),value:before,
  }])
  if(result.changedPaths.length!==1){
    const error=new Error('Setting no longer needs reverting.')
    error.status=409;throw error
  }
  return result
}
