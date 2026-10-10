import test from 'node:test'
import assert from 'node:assert/strict'
import {inspectCustomerConfigurationPromotion} from '../src/customerConfigurationPromotion.js'

const ready=env=>({environment:env,provisioning_status:'ready',
  isolation_verified_at:'2026-10-10T09:00:00Z'})
test('New Custom tenant cannot push from unprovisioned UAT',()=>{
  const d=inspectCustomerConfigurationPromotion({
    preference:{update_mode:'admin_controlled',customer_uat_opt_in:true},
    uat:{environment:'uat',provisioning_status:'pending',isolation_verified_at:null},
    live:{environment:'live',provisioning_status:'ready',isolation_verified_at:null},
    keys:['theme']})
  assert.equal(d.eligibleForReview,false)
  assert.equal(d.eligibleForExecution,false)
  assert.match(d.blockers.join(' '),/UAT/)
  assert.match(d.blockers.join(' '),/Production/)
})
test('Undecided onboarding update method is not an implicit Custom approval',()=>{
  const d=inspectCustomerConfigurationPromotion({
    preference:{update_mode:'admin_controlled',onboarding_selection_pending:true,
      customer_uat_opt_in:true},
    uat:ready('uat'),live:ready('live'),keys:['theme']})
  assert.equal(d.eligibleForReview,false)
  assert.equal(d.eligibleForExecution,false)
  assert.match(d.blockers.join(' '),/not selected/)
})
test('Managed tenant is denied customer-specific manual configuration promotion',()=>{
  const d=inspectCustomerConfigurationPromotion({
    preference:{update_mode:'hi5_managed',customer_uat_opt_in:true},
    uat:ready('uat'),live:ready('live'),keys:['theme']})
  assert.equal(d.eligibleForReview,false)
  assert.match(d.blockers.join(' '),/Custom/)
})
test('Even validated UAT and Production only become eligible for independent review',()=>{
  const d=inspectCustomerConfigurationPromotion({
    preference:{update_mode:'admin_controlled',customer_uat_opt_in:true},
    uat:ready('uat'),live:ready('live'),keys:['theme','itsm']})
  assert.equal(d.eligibleForReview,true)
  assert.equal(d.eligibleForExecution,false)
  assert.equal(d.requiresIndependentApproval,true)
  assert.ok(d.excludes.includes('credentials'))
})
test('Malicious, data-bearing and duplicate setting categories fail closed',()=>{
  for(const keys of [[],['tenant_records'],['credentials'],['theme','theme'],['theme',null],
    ['../../../db'],['theme','itsm','rmm','groups','permissions','integrations','billing']]){
    const d=inspectCustomerConfigurationPromotion({
      preference:{update_mode:'admin_controlled',customer_uat_opt_in:true},
      uat:ready('uat'),live:ready('live'),keys})
    assert.equal(d.eligibleForReview,false,JSON.stringify(keys))
  }
})
