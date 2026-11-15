import assert from 'node:assert/strict'
import {test} from 'node:test'
import {argumentDigest,managedActions,validateManagedAction} from './rmmEpmManagedUacPolicy.js'
const paths={
  notepad:'C:\\Windows\\System32\\notepad.exe',
  regedit:'C:\\Windows\\regedit.exe',
  services:'C:\\Windows\\System32\\mmc.exe',
  powershell:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'msiexec-help':'C:\\Windows\\System32\\msiexec.exe'
}
test('all five fixed Windows operations have a fully bound executable and arguments',()=>{
  for(const [operationCode,a] of Object.entries(managedActions)) {
    assert.equal(validateManagedAction({
      source:'managed-uac',operationCode,argumentsSha256:argumentDigest(a.arguments),
      filePath:paths[operationCode],autoLaunchOnApproval:true
    }).ok,true,operationCode)
  }
})
test('path, arguments digest, source and automatic execution cannot be substituted',()=>{
  for(const [operationCode,a] of Object.entries(managedActions)) {
    const base={source:'managed-uac',operationCode,argumentsSha256:argumentDigest(a.arguments),filePath:paths[operationCode],autoLaunchOnApproval:true}
    for(const bad of [{argumentsSha256:'A'.repeat(64)}, {filePath:'C:\\Temp\\'+a.executable},
      {source:'native-uac'},{autoLaunchOnApproval:false},
      {operationCode:'unapproved'}])assert.equal(validateManagedAction({...base,...bad}).ok,false)
  }
})
test('legacy Explorer requests cannot silently acquire typed execution arguments',()=>{
  assert.equal(validateManagedAction({source:'explorer'}).ok,true)
  assert.equal(validateManagedAction({source:'native-uac'}).ok,true)
  assert.equal(validateManagedAction({source:'explorer',operationCode:'powershell',argumentsSha256:'A'.repeat(64)}).ok,false)
})
