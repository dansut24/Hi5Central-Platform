import test from 'node:test'
import assert from 'node:assert/strict'
import {
 normaliseMsiProductCode, eligibleSelfServiceUninstall,
 isVerifiedRemovalJob,
} from '../src/appPortalMsiUninstall.js'

const rev={ source_type:'custom', publish_state:'published',
 installer_type:'msi', expected_signer:'Verified Vendor Ltd.',
 verification:{method:'uninstall_registry',
  productCode:'{123E4567-E89B-12D3-A456-426614174000}'} }
const app={id:'app-123',revisionId:'rev-456'}

test('allow only opt-in signed published MSI with exact product code',()=>{
 assert.equal(eligibleSelfServiceUninstall(rev,true),
 '{123E4567-E89B-12D3-A456-426614174000}')
 for(const patch of [
 {installer_type:'exe'},{publish_state:'draft'},
 {source_type:'catalogue'},{expected_signer:''},
 {verification:{method:'file_version',productCode:rev.verification.productCode}},
 {verification:{method:'uninstall_registry',productCode:'; rm -rf /'}}
 ]) assert.equal(eligibleSelfServiceUninstall({...rev,...patch},true),'')
 assert.equal(eligibleSelfServiceUninstall(rev,false),'')
})

test('reject command injection and malformed product codes',()=>{
 for(const bad of ['', 'one', '{123}', '..\\\\evil',
  '{123E4567-E89B-12D3-A456-426614174000};whoami',
  '123E4567-E89B-12D3-A456-426614174000.exe'])
  assert.equal(normaliseMsiProductCode(bad),'')
})

test('normalise bare product code to a fixed braced GUID',()=>{
 assert.equal(normaliseMsiProductCode('123e4567-e89b-12d3-a456-426614174000'),
 '{123E4567-E89B-12D3-A456-426614174000}')
})

test('only verified success for same app and revision clears installation',()=>{
 const good={app_id:app.id,revision_id:app.revisionId,
 status:'completed',result:{success:true,removalVerified:true}}
 assert.equal(isVerifiedRemovalJob(good,app),true)
 for(const patch of [
 {status:'queued'},{status:'failed'},{revision_id:'old-revision'},
 {app_id:'someone-else'},{result:{success:true,removalVerified:false}},
 {result:{success:false,removalVerified:true}}
 ]) assert.equal(isVerifiedRemovalJob({...good,...patch},app),false)
})
