// Pilot pinned to one tested application artifact. This is release metadata,
// not a customer configuration flag and not a trigger for image deployment.
// The SHA is supplied by the trusted release operator after CI builds the artifact.
// Never bake a circular/self-referential SHA into the image itself.
export const TESTED_AI_BUILD_SHA=String(process.env.CONFIGURATION_RELEASE_AI_APPROVED_BUILD_SHA||'').trim().toLowerCase()
export const approvedAiBuildConfigured=()=>/^[a-f0-9]{40}$/.test(TESTED_AI_BUILD_SHA)
export const AI_CONFIG_PATH='itsm.aiAssistant'
export function acceptedAiChange({change,acceptance}){
  return Boolean(approvedAiBuildConfigured()&&change&&change.id===AI_CONFIG_PATH&&change.to===true
    &&acceptance?.tested_build_sha===TESTED_AI_BUILD_SHA
    &&acceptance?.uat_configuration_hash===change.afterHash)
}
export function verifiedAiProductionBuild({row,now=new Date()}){
  if(!approvedAiBuildConfigured()||!row||row.status!=='verified')return false
  if(row.api_sha!==TESTED_AI_BUILD_SHA||row.itsm_sha!==TESTED_AI_BUILD_SHA)return false
  const age=now.getTime()-new Date(row.observed_at).getTime()
  return Number.isFinite(age)&&age>=0&&age<=24*60*60*1000
}
export function shouldApplyAiVersionGate(change){
  return change?.id===AI_CONFIG_PATH&&change.to===true
}
