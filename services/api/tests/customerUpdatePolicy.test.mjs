import assert from 'node:assert/strict'
import test from 'node:test'
import {parseCustomerUpdatePolicy,customerUpdateWriteParams,CUSTOMER_UPDATE_UPSERT} from '../src/customerUpdatePolicy.js'
import {readFileSync} from 'node:fs'

test('Managed: customer UAT not required; schedule is explicit, internal UAT stays independent',()=>{
  const p=parseCustomerUpdatePolicy({updateMode:'hi5_managed',deploymentDay:'wed',
    deploymentTime:'21:30',deploymentTimezone:'Europe/London'})
  assert.equal(p.customerUatRequired,false)
  assert.equal(p.customerUatOptIn,false)
  assert.equal(p.updateMode,'hi5_managed')
  assert.equal(p.uatAutoStage,false,'Do not automatically stage a customer UAT')
  assert.equal(p.liveAutoPromote,true)
  assert.deepEqual(p.maintenanceWindow,{timezone:'Europe/London',
    days:['wed'],start:'21:30',end:'23:30'})
  const opted=parseCustomerUpdatePolicy({updateMode:'hi5_managed',
    customerUatOptIn:true,deploymentDay:'fri',
    deploymentTime:'23:15',deploymentTimezone:'America/New_York'})
  assert.equal(opted.customerUatRequired,false)
  assert.equal(opted.customerUatOptIn,true)
  assert.equal(opted.maintenanceWindow.end,'01:15')
})
test('Custom: user controls UAT to Production, no automatic staging/promotions',()=>{
  const p=parseCustomerUpdatePolicy({updateMode:'admin_controlled'})
  assert.equal(p.customerUatRequired,true)
  assert.equal(p.customerUatOptIn,true)
  assert.equal(p.uatAutoStage,false)
  assert.equal(p.liveAutoPromote,false)
  assert.deepEqual(p.maintenanceWindow.days,[])
  assert.equal(parseCustomerUpdatePolicy({updateMode:'admin_controlled',customerUatOptIn:false}).customerUatOptIn,true)
})
test('Invalid / malformed mode, date, time, timezone fail closed',()=>{
  const invalid=[{},null,{updateMode:'managed'},{updateMode:'hi5_managed',deploymentDay:'everyday'},
    {updateMode:'hi5_managed',deploymentTime:'24:00'},
    {updateMode:'hi5_managed',deploymentTime:'tomorrow'},
    {updateMode:'hi5_managed',deploymentTimezone:'Mars/Phobos'},
    {updateMode:'hi5_managed',deploymentTimezone:'../../../etc/passwd'}]
  for(const p of invalid)assert.throws(()=>parseCustomerUpdatePolicy(p),Error)
  assert.equal(parseCustomerUpdatePolicy({}, {requireChoice:false}),null)
})
test('Managed and Custom SQL updates use parameterised audited tenant-specific preferences',()=>{
 const p=parseCustomerUpdatePolicy({updateMode:'hi5_managed',deploymentDay:'sun'})
 const params=customerUpdateWriteParams('tenant-uuid',p,'owner-id')
 assert.equal(params[0],'tenant-uuid')
 assert.equal(params[1],'hi5_managed')
 assert.equal(params[2],false)
 assert.equal(params[3],true)
 assert.equal(params[7],false)
 assert.equal(params[8],'owner-id')
 assert.match(CUSTOMER_UPDATE_UPSERT,/WHERE|ON CONFLICT \(tenant_id\)/)
 assert.match(CUSTOMER_UPDATE_UPSERT,/customer_uat_opt_in=EXCLUDED.customer_uat_opt_in/)
})
test('New customer and workspace onboarding persist the same update choice',()=>{
 const platform=readFileSync(new URL('../src/platformAdmin.js',import.meta.url),'utf8')
 const api=readFileSync(new URL('../src/index.js',import.meta.url),'utf8')
 const wizard=readFileSync(new URL('../../../apps/itsm/src/features/onboarding/OnboardingWizard.jsx',import.meta.url),'utf8')
 const admin=readFileSync(new URL('../../../apps/admin/src/features/admin/PlatformAdminApp.jsx',import.meta.url),'utf8')
 assert.match(platform,/parseCustomerUpdatePolicy\(body\)/)
 assert.match(platform,/CUSTOMER_UPDATE_UPSERT/)
 assert.match(api,/'updates'/)
 assert.match(api,/parseCustomerUpdatePolicy\(data\)/)
 assert.match(api,/CUSTOMER_UPDATE_UPSERT/)
 assert.match(wizard,/customerUatOptIn/)
 assert.match(wizard,/Keeping up to date/)
 assert.match(admin,/draft\.updateMode==='hi5_managed'/)
 assert.match(admin,/draft\.updateMode==='admin_controlled'/)
})
