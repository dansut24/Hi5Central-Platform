import test from 'node:test'
import assert from 'node:assert/strict'
import {renderQaGatewayEntitlementOverlay as render,
 expectedQaDeniedAliases as aliases} from '../src/qaGatewayEntitlementOverlay.js'

const tenants=[
 ['h5c-managed-qa26','hi5_managed',false],
 ['managed1','hi5_managed',false],
 ['managed2','hi5_managed',false],
 ['h5c-managed-rmm-qa27','hi5_managed',true],
 ['qa27-managed-itsm-qa27','hi5_managed',false],
 ['h5c-custom-qa26','admin_controlled',false],
 ['custom1','admin_controlled',false],
 ['custom2','admin_controlled',false],
 ['qa27-custom-rmm-qa27','admin_controlled',true],
 ['qa27-custom-itsm-qa27','admin_controlled',false],
].map(([slug,mode,rmm])=>({slug,mode,rmm}))

const source='# reviewed source\n'+'#'.repeat(2050)+'\n'
 +'    @tenantUatWorkspace expression existing-check\n'
 +'    handle @tenantUatWorkspace { reverse_proxy uat-gateway:80 }\n'
 +'    @tenantRmm expression existing-rmm-check\n'
 +'    handle @tenantRmm { reverse_proxy hi5central-prod-rmm:80 }\n'

test('only verified Managed UAT and non-RMM QA aliases receive deny handling',()=>{
 const candidate=render(source,tenants)
 const declared=aliases(tenants)
 assert.equal(declared.managedUat.length,10)
 assert.equal(declared.nonRmm.length,8)
 assert.equal(declared.sandboxRmm.length,20)
 assert.equal(declared.rmmAllowed.length,2)
 for(const host of [...declared.managedUat,...declared.nonRmm,...declared.sandboxRmm]){
  const regex=new RegExp(host.replaceAll('.','[.]'),'g')
  assert.equal([...candidate.matchAll(regex)].length,1,'Exact restricted host: '+host)
 }
 for(const host of declared.rmmAllowed)
  assert.equal(candidate.includes(host),false,'RMM-entitled Live alias must stay allowed.')
 for(const host of ['qa27-custom-itsm-qa27-uat.hi5central.com',
                    'qa27-custom-rmm-qa27-uat.hi5central.com']){
  assert.equal(candidate.includes(host),false,'Custom UAT must not be denied.')
 }
 assert(candidate.indexOf('QA_ENTITLEMENT_GUARD_UAT_BEGIN')
  <candidate.indexOf('@tenantUatWorkspace'))
 assert(candidate.indexOf('QA_ENTITLEMENT_GUARD_RMM_BEGIN')
  <candidate.indexOf('@tenantRmm'))
 assert(candidate.includes('reverse_proxy hi5central-prod-rmm:80'))
 assert(candidate.includes('reverse_proxy uat-gateway:80'))
 assert.equal(candidate.split('@qaManagedUatDenied host').length,2)
 assert.equal(candidate.split('@qaRmmDenied host').length,2)
 assert.match(candidate,/RMM is available only on entitled Live tenants/)
})
test('never changes or overwrites a partially reconciled Caddy source',()=>{
 const rendered=render(source,tenants)
 assert.throws(()=>render(rendered,tenants),/already present/)
 assert.throws(()=>render(source+'\n# QA_ENTITLEMENT_GUARD_RMM_END',tenants),
  /already present/)
 assert.throws(()=>render(source.replace('@tenantRmm expression','@other expression'),tenants),
  /expected unique/)
 assert.throws(()=>render(source.replace('@tenantRmm expression',
  '@tenantRmm expression\n    @tenantRmm expression'),tenants),/expected unique/)
})
test('denies unsafe scope changes and missing or fabricated entitlements',()=>{
 for(const wrong of [
  tenants.slice(1),
  [...tenants,tenants[0]],
  tenants.map(x=>({...x,mode:'hi5_managed'})),
  tenants.map(x=>({...x,rmm:false})),
  tenants.map(x=>({...x,slug:'../bad-tenant'})),
  tenants.map(x=>({...x,rmm:null})),
 ]){
  assert.throws(()=>render(source,wrong),/QA|Invalid|RMM|mode|entitlement/)
 }
})
