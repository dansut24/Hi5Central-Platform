import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Hono} from 'hono'
import {registerPlatformTenantOverviewRoutes} from '../src/platformTenantOverview.js'
const id='11111111-1111-4111-8111-111111111111'

const user=()=>({session:{role:'admin',user_id:'admin'}})
test('tenant overview rejects unauthenticated calls before querying any tenant data',async()=>{
  let read=false
  const app=new Hono()
  registerPlatformTenantOverviewRoutes(app,{
    requireAdmin:async c=>({error:c.json({error:'Unauthorised'},401)}),
    pool:{query:async()=>{read=true;throw Error('Access not permitted')}},
  })
  const r=await app.request('/api/platform/v1/tenants/'+id+'/overview')
  assert.equal(r.status,401)
  assert.equal(read,false)
})
test('tenant overview enforces UUID input and scopes all data reads to exactly one tenant',async()=>{
  const sqlRead=[]
  const recent=new Date().toISOString()
  const old=new Date(Date.now()-32*86400000).toISOString()
  const pool={async query(text,args){
    sqlRead.push({text,args})
    if(text.includes('FROM platform_database_backup_evidence')){
      assert.deepEqual(args,['2026-10-11T09:00:00Z'],'Platform archive must postdate onboarding completion')
      return {rows:[{environment:'live',coverage:'shared_database',
        archive_created_at:'2026-10-13T19:30:19Z',archive_bytes:36324078,
        inspected_at:'2026-10-13T21:00:00Z',inspection:'archive_list_checked',
        restore_tested_at:null,source_label:'admin-deployment-preflight'}]}
    }
    assert.deepEqual(args,[id],'Tenant-scoped queries must not access other organisations')
    if(text.includes('FROM tenants t JOIN tenant_settings'))
      return {rows:[{
        id,slug:'example-tenant',company_name:'Example Tenant',status:'active',
        created_at:'2026-10-10T09:00:00Z',onboarding_completed_at:'2026-10-11T09:00:00Z',
        modules:{itsm:true,rmm:true},plan_key:'pro',billing_status:'trial',
        billing_cycle:'monthly',currency:'GBP',base_monthly_price_pence:1200,
        rmm_device_price_pence:300,trial_ends_at:'2026-11-01T00:00:00Z',
      }],rowCount:1}
    if(text.includes('FROM rmm_agent_devices'))
      return {rows:[
        {id:'a',last_telemetry_at:recent,websocket_status:'Connected',disabled_at:null},
        {id:'b',last_telemetry_at:old,websocket_status:'Disconnected',disabled_at:null},
      ]}
    if(text.includes('FROM tenant_environment_state'))
      return {rows:[{environment:'live',status:'ready',active_release_ref:'release-1',
        last_deployed_at:recent,assigned_build_sha:null,pool_verified_at:null}]}
    if(text.includes('FROM tenant_runtime_update_offers'))return {rows:[]}
    if(text.includes('FROM platform_tenant_backup_records'))return {rows:[]}
    if(text.includes('FROM platform_tenant_invoice_records'))return {rows:[]}
    if(text.includes('FROM tenant_feature_release_approvals'))return {rows:[]}
    if(text.includes('FROM tenant_application_release_reviews'))return {rows:[]}
    throw Error('Unrecognised tenant query in route test')
  }}
  const app=new Hono()
  registerPlatformTenantOverviewRoutes(app,{pool,requireAdmin:async()=>user()})
  const bad=await app.request('/api/platform/v1/tenants/not-a-uuid/overview')
  assert.equal(bad.status,400)
  assert.equal(sqlRead.length,0)
  const r=await app.request('/api/platform/v1/tenants/'+id+'/overview')
  assert.equal(r.status,200)
  const body=await r.json()
  assert.equal(body.tenant.slug,'example-tenant')
  assert.equal(body.deviceUsage.billable,1)
  assert.equal(body.deviceUsage.offlineOver30Days,1)
  assert.equal(body.subscription.estimatedMonthlyPence,1500)
  assert.equal(body.backup.availability,'no_verified_backup_records')
  assert.equal(body.invoices.items.length,0)
  assert.equal(body.environments[0].versionConfidence,'unverified')
  assert.equal(body.backup.sharedPlatformDatabase.perTenantRestorePoint,false)
  assert.equal(body.backup.sharedPlatformDatabase.isolatedRestoreTested,false)
  assert.equal(body.backup.sharedPlatformDatabase.sizeBytes,36324078)
  assert.equal(sqlRead.length,9)
})
