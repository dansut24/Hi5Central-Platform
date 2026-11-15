// Review-only native UAC has no target identity, so it cannot auto-start.
// Legacy Explorer file requests remain manual by default.
export function validateFileAutoLaunchIntent(body) {
  const value=body?.autoLaunchOnApproval
  if (value===undefined || value===false) return {ok:true, autoLaunchOnApproval:false}
  if (value!==true || body?.source!=='explorer')
    return {ok:false,error:'Automatic launch requires an explicit verified Explorer EXE request.'}
  return {ok:true,autoLaunchOnApproval:true}
}
