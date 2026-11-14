// Pure compliance evaluation, backed by durable authenticated Agent job receipts.
// A policy is never considered compliant merely because its job was queued.
export const SUPPORTED_WINDOWS_CHECKS = Object.freeze([
  'windows.filesystem.long_paths_enabled',
  'windows.smb1.enabled',
  'windows.firewall.domain.enabled',
  'windows.firewall.private.enabled',
  'windows.firewall.public.enabled',
  'windows.laps.backup_directory',
])
export const ASSESSMENT_MAX_AGE_MS = 24*60*60*1000

export function effectiveAuditSettings(resolution) {
  return (resolution?.applicable ? resolution.settings : [])
    .filter((item)=>SUPPORTED_WINDOWS_CHECKS.includes(item.key) &&
      (item.state==='configured'||item.state==='overridden'))
    .map((item)=>({key:item.key,value:item.value,state:item.state}))
    .sort((a,b)=>a.key.localeCompare(b.key))
}
export function assessmentSignature(profileRevision, settings) {
  return JSON.stringify({revision:profileRevision,desired:[...settings].sort((a,b)=>a.key.localeCompare(b.key))
    .map(({key,value,state})=>({key,value,state}))})
}
export function shouldQueueAutomaticAudit(jobs,signature,now=Date.now()) {
  const latest=jobs.find((job)=>job.request_metadata?.action==='audit')
  if(!latest)return true
  if(['queued','claimed'].includes(latest.status))return false
  const changedSince=jobs.some((job)=>['apply','restore'].includes(job.request_metadata?.action) &&
    new Date(job.created_at)>new Date(latest.created_at))
  if(changedSince)return true
  if(latest.request_metadata?.assessment_signature!==signature)return true
  const created=now-new Date(latest.created_at).getTime()
  return created>=(latest.status==='completed'?ASSESSMENT_MAX_AGE_MS:3600000)
}
export function readAssessmentReport(job, parseResult) {
  const parsed=parseResult(job?.result?.output)
  if (!parsed || parsed.action!=='audit' || !Array.isArray(parsed.results)) return null
  return parsed
}
export function assessDevicePolicy({profile,resolution,agent=null,jobs=[],parseResult,now=Date.now()}) {
  const applicable=Boolean(resolution?.applicable)
  if (!applicable) return {status:'not_targeted',settings:[],lastCheckedAt:null}
  if (profile.status!=='ready') return {status:'paused',settings:[],lastCheckedAt:null}
  const desired=effectiveAuditSettings(resolution)
  const excluded=resolution.settings.filter((s)=>s.state==='excluded')
  const conflicts=resolution.settings.filter((s)=>s.state==='conflict')
  const unsupported=resolution.settings.filter((s)=>
    !SUPPORTED_WINDOWS_CHECKS.includes(s.key) && s.state!=='excluded')
  if (conflicts.length) return {status:'conflict',settings:[],excluded:excluded.length,unsupported:unsupported.map(x=>x.key),lastCheckedAt:null}
  if (!desired.length) return {status:unsupported.length?'unsupported':'excluded',
    settings:[],excluded:excluded.length,unsupported:unsupported.map(x=>x.key),lastCheckedAt:null}
  const latest=jobs.find((job)=>job.request_metadata?.action==='audit')||null
  const laterChange=jobs.find((job)=>['apply','restore'].includes(job.request_metadata?.action))||null
  const online=agent?.websocket_status==='Connected' &&
    agent?.last_authenticated_at && now-new Date(agent.last_authenticated_at).getTime()<120000
  if(!online) return {status:'offline',settings:desired.map(x=>({...x,status:'pending'})),
    excluded:excluded.length,unsupported:unsupported.map(x=>x.key),lastCheckedAt:latest?.completed_at||null}
  const currentSignature=assessmentSignature(profile.revision,desired)
  const signatureMatches=latest?.request_metadata?.assessment_signature===currentSignature
  const fresh=latest && now-new Date(latest.completed_at||latest.created_at).getTime()<ASSESSMENT_MAX_AGE_MS
  const changedSinceAudit=laterChange && (!latest || new Date(laterChange.created_at)>new Date(latest.created_at))
  if(!latest||!signatureMatches||!fresh||changedSinceAudit||['queued','claimed'].includes(latest.status))
    return {status:'pending',settings:desired.map(x=>({...x,status:'pending'})),
      excluded:excluded.length,unsupported:unsupported.map(x=>x.key),lastCheckedAt:latest?.completed_at||null}
  if(latest.status!=='completed')
    return {status:'error',settings:desired.map(x=>({...x,status:'error'})),
      excluded:excluded.length,unsupported:unsupported.map(x=>x.key),lastCheckedAt:latest.completed_at||null}
  const report=readAssessmentReport(latest,parseResult)
  if(!report||report.profileId!==profile.id)
    return {status:'error',settings:desired.map(x=>({...x,status:'error'})),
      excluded:excluded.length,unsupported:unsupported.map(x=>x.key),lastCheckedAt:latest.completed_at||null}
  const results=desired.map((item)=>{
    const observed=report.results.find((r)=>r.key===item.key)
    if(!observed||observed.action!=='audit'||observed.status!=='observed')
      return {...item,status:'error'}
    return {...item,observed:observed.observed,
      status:Object.is(item.value,observed.observed)?'compliant':'drift'}
  })
  const status=results.some(x=>x.status==='error')?'error'
    :results.some(x=>x.status==='drift')?'drift'
      :unsupported.length?'partial':'compliant'
  return {status,settings:results,excluded:excluded.length,unsupported:unsupported.map(x=>x.key),
    lastCheckedAt:latest.completed_at||null,jobId:latest.id}
}
export function rollupCompliance(devices=[]) {
  const counts={compliant:0,drift:0,pending:0,offline:0,error:0,conflict:0,partial:0,unsupported:0,excluded:0,paused:0}
  for(const device of devices){
    if(Object.hasOwn(counts,device.status))counts[device.status]++
  }
  return {assigned:devices.length,...counts}
}
