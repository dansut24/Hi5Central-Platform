/**
 * Release history retains only deliberately approved, non-secret ITSM
 * setting values. NEVER store arbitrary strings, passwords, URLs, free-text,
 * emails, webhook configuration or caller-authored before/after metadata.
 *
 * The server derives these values from locked persisted settings and known
 * presentation defaults. Existing hash-only events cannot be reconstructed.
 */
const BOOLEAN_KEYS = Object.freeze({
  dashboard:['showServiceHealth','showRecentActivity','showApprovals','showProjects'],
  queues:['rememberFilters','allowSavedViews','showSla','openInTabs'],
  incidents:['requireResolutionCode','autoAssignDefaultTeam'],
  serviceRequests:['requesterCanCancel','pauseSlaForApproval','requireCompletionNote'],
  problems:['requireRootCause','requireKnownErrorReview','allowIncidentLinking'],
  changes:['requireImplementationPlan','requireTestPlan','requireBackoutPlan','enforceApproval'],
  tasks:['inheritParentTeam','requireAssigneeToStart','requireCompletionNote','showOnCalendar'],
  catalogue:['enabled','requireOwner','showPrices','allowOneOffRequests','requireApprovalForCost'],
  projects:['enabled','requireOwner','syncCalendar','showTaskDueDates','showMilestones'],
  calendar:['showChanges','showProjects','showTasks','showRota'],
  liveChatConfig:['enabled','autoClaimOnReply','allowTransfer','createIncidentFromChat'],
  cmdb:['enabled','linkRecords','showRmmDevices','requireOwnerForManualCi','allowManualCi'],
  knowledge:['internalEnabled','portalEnabled','feedbackEnabled','requireReview'],
  reports:['enabled','allowExport','allowSavedViews','includeClosed'],
  attachments:['requesterUploads','internalAttachments'],
})
const ROOT_BOOLEAN_KEYS = new Set([
  'portalKnowledge','requesterComments','liveChat','aiAssistant',
  'standardChangeAutoApprove','requesterNotifications','slaWarnings',
  'knowledgeFeedback',
])
const NUMERIC_KEYS = new Set([
  'recordDigits','managerApprovalThreshold','incidents.reopenDays',
  'serviceRequests.autoCloseDays','knowledge.reviewDays',
  'reports.defaultRangeDays','queues.pageSize','attachments.maxMb',
  'liveChatConfig.inactivityMinutes',
])
const SLA_KEYS = new Set(['slaTargets','serviceRequestSlaTargets','projectSlaTargets'])
const PRIORITIES = new Set(['Critical','High','Medium','Low'])
const LABELLED_DEFAULTS = Object.freeze({
  // UI default for projects.showMilestones in ProductionSettingsWorkspace.
  'projects.showMilestones':true,
})
const ENUMS = Object.freeze({
  'numberingMode':['default','custom'],
  'dashboard.defaultRange':['today','7d','30d'],
  'queues.defaultView':['table','compact','cards'],
  'projects.defaultHealth':['On track','At risk','Blocked'],
  'calendar.weekStart':['monday','sunday'],
  'incidents.defaultStatus':['New','Assigned','In Progress'],
  'incidents.defaultPriority':['Low','Medium','High','Critical'],
  'serviceRequests.defaultStatus':['New','Assigned','In Progress'],
  'problems.defaultStatus':['New','Investigation','Known Error'],
  'changes.defaultType':['Standard','Normal','Emergency'],
  'tasks.defaultStatus':['Open','Assigned'],
  'businessHours':['uk-business','24x7','custom'],
  'defaultPriority':['Low','Medium','High','Critical'],
})

function approvedKind(path) {
  const parts=path.split('.')
  if(parts.length===1&&ROOT_BOOLEAN_KEYS.has(parts[0]))return 'boolean'
  if(parts.length===2&&BOOLEAN_KEYS[parts[0]]?.includes(parts[1]))return 'boolean'
  if(NUMERIC_KEYS.has(path))return 'number'
  if(parts.length===3&&SLA_KEYS.has(parts[0])&&PRIORITIES.has(parts[1])
    &&(parts[0]==='projectSlaTargets'
      ?parts[2]==='targetDays'
      :['responseMinutes','resolutionMinutes'].includes(parts[2])))
    return 'number'
  if(Object.prototype.hasOwnProperty.call(ENUMS,path))return 'enum'
  return null
}
function getPath(source,path) {
  let value=source
  for(const part of path.split('.')){
    if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,part))
      return undefined
    value=value[part]
  }
  return value
}
function safeValue(kind,path,value) {
  if(kind==='boolean')return typeof value==='boolean'?value:undefined
  if(kind==='number'){
    // Numeric editor values are generally strings; never persist arbitrary
    // free text simply because it arrived in a numeric settings field.
    if((typeof value!=='number'&&typeof value!=='string')
      ||!/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(String(value)))
      return undefined
    return String(value)
  }
  if(kind==='enum'&&typeof value==='string'&&ENUMS[path].includes(value))
    return value
  return undefined
}

/** Returns only explicitly approved display entries, never raw config blobs. */
export function itsmAuditValueChanges(before,after,changedPaths) {
  const result=[]
  const paths=Array.isArray(changedPaths)?changedPaths:[]
  for(const path of paths.slice(0,100)){
    if(typeof path!=='string')continue
    const kind=approvedKind(path)
    if(!kind)continue
    let previous=getPath(before,path)
    let previousSource='saved'
    if(previous===undefined&&Object.prototype.hasOwnProperty.call(LABELLED_DEFAULTS,path)){
      previous=LABELLED_DEFAULTS[path]
      previousSource='default'
    }
    const next=safeValue(kind,path,getPath(after,path))
    if(next===undefined)continue
    const old=safeValue(kind,path,previous)
    // Absence of an old value is explicit, never guessed. Some fields have
    // a documented effective UI default and may display "(default)".
    result.push({
      path,kind,before:old===undefined?null:old,after:next,
      beforeSource:old===undefined?'unknown':previousSource,
    })
  }
  return result
}
