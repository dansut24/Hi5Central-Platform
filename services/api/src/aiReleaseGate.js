// Pilot pinned to one tested application artifact. This is release metadata,
// not a customer configuration flag and not a trigger for image deployment.
export const TESTED_AI_BUILD_SHA='27a8974dc337dcb255c9f561e7954281453d60f6'
export const AI_CONFIG_PATH='itsm.aiAssistant'
export function acceptedAiChange({change,acceptance}){
  return Boolean(change&&change.id===AI_CONFIG_PATH&&change.to===true
    &&acceptance?.tested_build_sha===TESTED_AI_BUILD_SHA
    &&acceptance?.uat_configuration_hash===change.afterHash)
}
export function verifiedAiProductionBuild({row,now=new Date()}){
  if(!row||row.status!=='verified')return false
  if(row.api_sha!==TESTED_AI_BUILD_SHA||row.itsm_sha!==TESTED_AI_BUILD_SHA)return false
  const age=now.getTime()-new Date(row.observed_at).getTime()
  return Number.isFinite(age)&&age>=0&&age<=24*60*60*1000
}
export function shouldApplyAiVersionGate(change){
  return change?.id===AI_CONFIG_PATH&&change.to===true
}
