import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {verifyPilotAdminRecipientFile} from '../src/pilotAdminRecipient.js'
const email='pilot-admin@example.invalid'
const scopeId='bdc77d99-e95b-4ee8-9605-3a708a882c36'
const good={version:1,type:'first-platform-admin-recipient',email,scopeId,
 status:'recipient_authorized_identity_and_signer_approvals_pending',
 invitationIssued:false}
function temp(fn){
 const dir=mkdtempSync(join(tmpdir(),'hi5-pilot-recipient-'))
 try{
  const path=join(dir,'recipient.json')
  writeFileSync(path,JSON.stringify(good),{mode:0o600})
  return fn({dir,path})
 }finally{rmSync(dir,{recursive:true,force:true})}
}
test('Exact staged recipient and control DB scope accepted',()=>temp(({path})=>{
 const result=verifyPilotAdminRecipientFile(path,{email,scopeId})
 assert.equal(result.email,email)
 assert.equal(result.scopeId,scopeId)
}))
test('Different email, control-plane scope, or issuance flag are rejected',()=>temp(({path})=>{
 assert.throws(()=>verifyPilotAdminRecipientFile(path,{email:'attacker@example.invalid',scopeId}),/differs/)
 assert.throws(()=>verifyPilotAdminRecipientFile(path,{email,scopeId:'b14a0695-61e5-4699-b8b3-e33fdc354b47'}),/differs/)
 for(const altered of [{invitationIssued:true},{status:'approved'},{version:2}]){
  writeFileSync(path,JSON.stringify({...good,...altered}))
  assert.throws(()=>verifyPilotAdminRecipientFile(path,{email,scopeId}),/differs/)
 }
}))
test('Symlinks, group/world readability and malformed JSON fail closed',()=>temp(({dir,path})=>{
 const alias=join(dir,'alias.json')
 symlinkSync(path,alias)
 assert.throws(()=>verifyPilotAdminRecipientFile(alias,{email,scopeId}),/owner-only/)
 chmodSync(path,0o644)
 assert.throws(()=>verifyPilotAdminRecipientFile(path,{email,scopeId}),/owner-only/)
 chmodSync(path,0o600)
 writeFileSync(path,'{corrupted invalid json content at least thirty bytes')
 assert.throws(()=>verifyPilotAdminRecipientFile(path,{email,scopeId}),/invalid/)
}))
