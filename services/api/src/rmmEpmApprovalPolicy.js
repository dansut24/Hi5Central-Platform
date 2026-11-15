// Server-authoritative EPM launch risk. Never infer a safe launch from a
// native-UAC review without a target. High-risk interactive admin consoles
// cannot be limited by the approved initial command's argument hash.
const CRITICAL=new Set(['powershell','regedit'])
const HIGH=new Set(['services','notepad'])
const CONTROLLED=new Set(['msiexec-help'])
export function assessEpmApproval(row,{profile='hardened',breakGlassEnabled=false}={}) {
  const managed=row?.request_source==='managed-uac'
  const action=managed?String(row.managed_action_code||''):''
  let risk='high'
  let description='A signed executable can run privileged code or spawn further processes.'
  if(managed && CRITICAL.has(action)) {
    risk='critical'
    description='An interactive administrative console can make further unrestricted changes after launch.'
  } else if(managed && HIGH.has(action)) {
    risk='high'
    description='An elevated Windows management tool can modify system settings or files after launch.'
  } else if(managed && CONTROLLED.has(action)) {
    risk='controlled'
    description='Pre-registered Windows Installer help command with fixed /? arguments.'
  } else if(managed) {
    return {risk:'blocked',allowed:false,requiredApprovers:0,
      ttlMinutes:0,minNoteLength:0,description:'Unrecognised managed Windows action.'}
  }
  const isPilot=profile==='pilot'
  const requiresBreakGlass=risk==='critical'
  if(requiresBreakGlass && !isPilot && !breakGlassEnabled)
    return {risk,allowed:false,requiredApprovers:0,ttlMinutes:0,
      minNoteLength:40,description:description+' Explicit break-glass policy is disabled.'}
  return {
    risk,allowed:true,
    requiredApprovers:!isPilot && requiresBreakGlass?2:1,
    ttlMinutes:risk==='critical'?3:risk==='high'?5:15,
    minNoteLength:!isPilot && requiresBreakGlass?40:10,
    description,
    // Even a dual approval still starts an unrestricted elevated console:
    // session containment/monitoring is not a command-level sandbox.
    unrestrictedSession:requiresBreakGlass || (managed && HIGH.has(action))
  }
}
export function decideEpmApproval(policy,decision,note,firstApproverId,technicianId,hasPolicyPermission) {
  const message=String(note??'').trim()
  if(!['approved','rejected'].includes(decision))
    return {ok:false,error:'Unknown EPM decision.'}
  if(message.length<10 || message.length>2000)
    return {ok:false,error:'A 10–2000 character technician explanation is required.'}
  if(decision==='rejected')return {ok:true,stage:'reject'}
  if(!policy?.allowed)
    return {ok:false,error:'EPM policy blocks this elevation. A review cannot release administrator privileges.'}
  if(message.length<policy.minNoteLength)
    return {ok:false,error:'This risk level requires a more detailed approval explanation.'}
  if(policy.requiredApprovers===1)return {ok:true,stage:'approve',ttlMinutes:policy.ttlMinutes}
  if(!hasPolicyPermission)
    return {ok:false,error:'Break-glass EPM approval requires RMM policy-management permission.'}
  if(!firstApproverId)return {ok:true,stage:'first-approval'}
  if(String(firstApproverId)===String(technicianId))
    return {ok:false,error:'A different authorised technician must provide the second approval.'}
  return {ok:true,stage:'second-approval',ttlMinutes:policy.ttlMinutes}
}
