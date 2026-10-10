import test from 'node:test'
import assert from 'node:assert/strict'
import {parseCustomerUpdatePolicy,saveOnboardingUpdatePolicy} from '../src/customerUpdatePolicy.js'

function fakeDb({uatExists=true,claimed=false}={}){
 const queries=[]
 return {queries,async query(sql,params){
  queries.push({sql,params})
  if(sql.includes("SELECT 1 FROM tenant_environment_instances"))
    return {rowCount:uatExists?1:0,rows:uatExists?[{available:true}]:[]}
  if(sql.includes("state='claimed'"))return {rowCount:claimed?1:0}
  return {rowCount:1,rows:[]}
 }}
}
test('Choosing Custom queues customer UAT only during signed-in onboarding',async()=>{
 const db=fakeDb()
 const p=parseCustomerUpdatePolicy({updateMode:'admin_controlled'})
 await saveOnboardingUpdatePolicy(db,'customer-id',p,'owner-user')
 assert.match(db.queries[0].sql,/onboarding_selection_pending=false/)
 assert.equal(db.queries[0].params[1],'admin_controlled')
 assert.equal(db.queries[0].params[3],false)
 assert.ok(db.queries.some(q=>q.sql.includes('INSERT INTO tenant_environment_provision_requests')))
 assert.ok(!db.queries.some(q=>q.sql.includes('UPDATE tenant_environment_provision_requests')))
})
test('Choosing Managed without customer UAT cancels only unclaimed pending requests',async()=>{
 const db=fakeDb()
 const p=parseCustomerUpdatePolicy({updateMode:'hi5_managed',deploymentDay:'wed',
  deploymentTime:'21:30',deploymentTimezone:'Europe/London'})
 await saveOnboardingUpdatePolicy(db,'customer-id',p,'owner-user')
 assert.equal(db.queries[0].params[1],'hi5_managed')
 assert.equal(db.queries[0].params[3],true)
 assert.ok(!db.queries.some(q=>q.sql.includes('INSERT INTO tenant_environment_provision_requests')))
 assert.ok(db.queries.some(q=>q.sql.includes("state='cancelled'")))
})
test('No silent cancellation of a claimed UAT environment',async()=>{
 const db=fakeDb({claimed:true})
 await assert.rejects(saveOnboardingUpdatePolicy(db,'customer-id',
  parseCustomerUpdatePolicy({updateMode:'hi5_managed'}),'owner-user'),/claimed/)
 assert.ok(!db.queries.some(q=>q.sql.includes("state='cancelled'")))
})
test('Customer UAT opt-in queues request, but never activates DNS, runtime or Production',async()=>{
 const db=fakeDb()
 await saveOnboardingUpdatePolicy(db,'customer-id',
  parseCustomerUpdatePolicy({updateMode:'hi5_managed',customerUatOptIn:true}),'owner-user')
 assert.ok(db.queries.some(q=>q.sql.includes('INSERT INTO tenant_environment_provision_requests')))
 assert.ok(db.queries.every(q=>!q.sql.includes('provisioning_status=\'ready\'')))
 assert.ok(db.queries.every(q=>!q.sql.includes('tenant_environment_feature_overrides')))
})
