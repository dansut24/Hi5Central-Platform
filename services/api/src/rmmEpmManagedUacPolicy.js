import { createHash } from 'node:crypto'

// Exactly five managed administrative actions, not a general-purpose shell
// or untrusted executable/argument parser. Approval binds both image and args.
export const managedActions=Object.freeze({
  notepad:       {executable:'notepad.exe', arguments:'', pattern:/^[A-Za-z]:\\Windows\\System32\\notepad\.exe$/i},
  regedit:       {executable:'regedit.exe', arguments:'', pattern:/^[A-Za-z]:\\Windows\\regedit\.exe$/i},
  services:      {executable:'mmc.exe', arguments:'services.msc', pattern:/^[A-Za-z]:\\Windows\\System32\\mmc\.exe$/i},
  powershell:    {executable:'powershell.exe', arguments:'-NoProfile -NoExit', pattern:/^[A-Za-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i},
  'msiexec-help':{executable:'msiexec.exe',arguments:'/?',pattern:/^[A-Za-z]:\\Windows\\System32\\msiexec\.exe$/i}
})
export function argumentDigest(value) {
  return createHash('sha256').update(value,'utf8').digest('hex').toUpperCase()
}
export function validateManagedAction({source,operationCode,argumentsSha256,filePath,autoLaunchOnApproval}) {
  if(source!=='managed-uac') return operationCode==null && argumentsSha256==null
    ? {ok:true,code:null,digest:null}
    : {ok:false,error:'Unbound request cannot declare a managed operation.'}
  const action=managedActions[operationCode]
  if(!action||!action.pattern.test(filePath)||autoLaunchOnApproval!==true
    ||argumentsSha256!==argumentDigest(action.arguments))
    return {ok:false,error:'Managed action must match an approved exact Windows executable and command-line digest.'}
  return {ok:true,code:operationCode,digest:argumentsSha256}
}
