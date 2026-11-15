import assert from 'node:assert/strict'
import {test} from 'node:test'
import {assessEpmApproval,decideEpmApproval} from './rmmEpmApprovalPolicy.js'
const managed=code=>({request_source:'managed-uac',managed_action_code:code})
const approve=(p,id=null,who='second',permission=true,note='Detailed authorised emergency production maintenance review to support this device')=>
  decideEpmApproval(p,'approved',note,id,who,permission)
test('five actions are risk-classified; generic EXE is not assumed harmless',()=>{
  assert.equal(assessEpmApproval(managed('regedit'),{profile:'pilot'}).risk,'critical')
  assert.equal(assessEpmApproval(managed('powershell'),{profile:'pilot'}).risk,'critical')
  assert.equal(assessEpmApproval(managed('services'),{profile:'pilot'}).risk,'high')
  assert.equal(assessEpmApproval(managed('notepad'),{profile:'pilot'}).risk,'high')
  assert.equal(assessEpmApproval(managed('msiexec-help'),{profile:'pilot'}).risk,'controlled')
  assert.equal(assessEpmApproval({request_source:'explorer'}, {profile:'pilot'}).risk,'high')
})
test('production default denies broad admin consoles until break-glass enabled',()=>{
  for(const code of ['regedit','powershell']) {
    const p=assessEpmApproval(managed(code))
    assert.equal(p.allowed,false)
    assert.equal(approve(p).ok,false)
  }
})
test('enabled production break-glass requires two different policy-authorised technicians',()=>{
  const p=assessEpmApproval(managed('powershell'),{breakGlassEnabled:true})
  assert.equal(p.requiredApprovers,2)
  assert.equal(p.ttlMinutes,3)
  assert.equal(approve(p).stage,'first-approval')
  assert.equal(approve(p,'first','first').ok,false)
  assert.equal(approve(p,'first','second',false).ok,false)
  assert.equal(approve(p,'first','second',true).stage,'second-approval')
  assert.equal(approve(p,'first','second',true,'too short').ok,false)
})
test('pilot compatibility keeps existing one-person approval while limiting TTL',()=>{
  for(const code of ['regedit','powershell','services','notepad','msiexec-help']) {
    const p=assessEpmApproval(managed(code),{profile:'pilot'})
    assert.equal(p.allowed,true)
    assert.equal(p.requiredApprovers,1)
    assert.equal(approve(p).stage,'approve')
  }
})
test('unknown managed operations and malformed approvals fail closed',()=>{
  const p=assessEpmApproval(managed('arbitrary-admin-command'),{profile:'pilot'})
  assert.equal(p.allowed,false)
  assert.equal(approve(p).ok,false)
  const ordinary=assessEpmApproval({request_source:'explorer'})
  assert.equal(decideEpmApproval(ordinary,'wrong','not a valid decision').ok,false)
  assert.equal(decideEpmApproval(ordinary,'rejected','An explicit rejection can always stop the request').stage,'reject')
})

test('production selected EXE requires exact admitted SHA256; signatures alone are insufficient',()=>{
  const fileHash='A'.repeat(64)
  const request={request_source:'explorer',file_sha256:fileHash}
  assert.equal(assessEpmApproval(request).allowed,false)
  assert.equal(assessEpmApproval(request,{allowedFileHashes:['B'.repeat(64)]}).allowed,false)
  assert.equal(assessEpmApproval(request,{allowedFileHashes:[fileHash]}).allowed,true)
  assert.equal(assessEpmApproval(request,{profile:'pilot'}).allowed,true)
})
