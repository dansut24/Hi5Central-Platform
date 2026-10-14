import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { qa26DemoAccountView,registerQa26DemoControlPlaneRoutes } from '../src/qa26DemoControlPlane.js'

const id='11111111-1111-4111-8111-111111111111'
const customId='22222222-2222-4222-8222-222222222222'
function stub(modules={itsm:true,rmm:false}){
  const state=new Map()
  const sql=[]
  return {sql,state,async query(q,args=[]){
    sql.push(q)
    if(q.includes('FROM tenants t JOIN tenant_settings ts')){
      const value=state.get(args[0])||{}
      return {rowCount:1,rows:[{created_at:new Date('2026-10-12T00:00:00Z'),
        modules,...{example_itsm:null,example_rmm:null,fake_paid_plan:null,extension_days:null},...value}]}
    }
    if(q.startsWith('SELECT kind,fake_sent_at'))return {rowCount:0,rows:[]}
    if(q.startsWith('SELECT b.user_id AS id'))return {rowCount:0,rows:[]}
    if(q.includes('SELECT 1 FROM qa26_demo_billing_delegates'))return {rowCount:0,rows:[]}
    if(q.startsWith('INSERT INTO qa26_demo_account_state')){
      const prior=state.get(args[0])||{}
      if(q.includes('extension_days')){state.set(args[0],{...prior,extension_days:14});return {rowCount:1,rows:[{tenant_id:args[0]}]}}
      if(q.includes('fake_paid_plan'))state.set(args[0],{...prior,fake_paid_plan:true,example_itsm:args[1],example_rmm:args[2]})
      else state.set(args[0],{...prior,example_itsm:args[1],example_rmm:args[2]})
      return {rowCount:1,rows:[{}]}
    }
    if(q.startsWith('INSERT INTO qa26_demo_reminder_log'))return {rowCount:1,rows:[]}
    if(q.startsWith('INSERT INTO qa26_demo_billing_delegates'))return {rowCount:0,rows:[]}
    if(q.startsWith('SELECT 1 FROM tenant_memberships'))return {rowCount:0,rows:[]}
    throw new Error('UNEXPECTED_QA_SQL '+q.slice(0,90))
  }}
}
const session=(slug='h5c-managed-qa26',role='owner',mfa=true)=>({
  tenant_id:slug==='h5c-custom-qa26'?customId:id,
  user_id:'33333333-3333-4333-8333-333333333333',
  slug,tenant_role:role,mfa_verified_at:mfa?new Date():null,authentication_type:'session'
})
const domain='https://h5c-managed-qa26-admin.hi5central.com'
function app(db,getSession=()=>session()){
 const a=new Hono()
 registerQa26DemoControlPlaneRoutes(a,async()=>getSession(),db)
 return a
}
const post=(path,body,origin=domain)=>({path,init:{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}})

test('30-day QA trial derives from account creation, not actual commercial settings',async()=>{
 const db=stub()
 const view=await qa26DemoAccountView(id,'h5c-managed-qa26',db,'2026-10-14T10:00:00Z')
 assert.equal(view.demo,true)
 assert.equal(view.realPayments,false)
 assert.equal(view.trial.daysTotal,30)
 assert.equal(view.trial.daysRemaining,28)
 assert.equal(view.trial.expired,false)
 assert.deepEqual(view.modules.availableToAdd,['rmm'])
 assert.equal(view.topology.rmmPortals,1)
 assert.equal(view.topology.rmmHasUat,false)
 assert.equal(view.topology.rmmHasTest,false)
 assert.equal(view.reminders.emailsActuallySent,0)
 assert.equal(view.reminders.deliveryMode,'PREVIEW_ONLY')
})
test('ITSM-only can add RMM and RMM-only can add ITSM, preserving other service',async()=>{
 const rmmOnly=stub({itsm:false,rmm:true})
 const v=await qa26DemoAccountView(customId,'h5c-custom-qa26',rmmOnly,'2026-10-14T00:00:00Z')
 assert.deepEqual(v.modules.availableToAdd,['itsm'])
 const itsmOnly=stub()
 const a=app(itsmOnly)
 let r=await a.request('/api/v1/qa26/demo-account/add-module',post('',{module:'rmm'}).init)
 assert.equal(r.status,200)
 const data=await r.json()
 assert.equal(data.realEntitlementChanged,false)
 assert.equal(data.rmmHasUat,false)
 assert.equal(data.rmmHasTest,false)
 assert.equal(data.rmmPortalCount,1)
 assert.equal(itsmOnly.state.get(id).example_itsm,true)
 assert.equal(itsmOnly.state.get(id).example_rmm,true)
 const b=app(rmmOnly,()=>session('h5c-custom-qa26'))
 r=await b.request('/api/v1/qa26/demo-account/add-module',
   post('',{module:'itsm'},'https://h5c-custom-qa26-admin.hi5central.com').init)
 assert.equal(r.status,200)
 assert.equal(rmmOnly.state.get(customId).example_itsm,true)
 assert.equal(rmmOnly.state.get(customId).example_rmm,true)
})
test('billing-only delegation cannot add modules or upgrade fake subscription; MFA required',async()=>{
 const db=stub()
 const a=app(db,()=>session('h5c-managed-qa26','technician'))
 const r=await a.request('/api/v1/qa26/demo-account/add-module',post('',{module:'rmm'}).init)
 assert.equal(r.status,403)
 const noMfa=app(db,()=>session('h5c-managed-qa26','owner',false))
 assert.equal((await noMfa.request('/api/v1/qa26/demo-account')).status,403)
 assert.equal((await noMfa.request('/api/v1/qa26/demo-account/activate',post('',{}).init)).status,403)
 assert.equal(db.state.size,0)
})
test('cross-tenant admin origin is rejected, and no client-provided tenant ID can override session',async()=>{
 const db=stub()
 const a=app(db)
 let r=await a.request('/api/v1/qa26/demo-account/add-module',
   post('',{module:'rmm'},'https://h5c-custom-qa26-admin.hi5central.com').init)
 assert.equal(r.status,403)
 r=await a.request('/api/v1/qa26/demo-account')
 assert.equal(r.status,200)
 const body=await r.json()
 assert.equal(body.tenant.id,id)
 assert.equal(db.state.size,0)
})
test('expired trial supports one-time fake 14-day extension, without real entitlement change',async()=>{
 const db=stub()
 const expired=await qa26DemoAccountView(id,'h5c-managed-qa26',db,'2026-11-13T01:00:00Z')
 assert.equal(expired.trial.expired,true)
 assert.equal(expired.trial.canRestore,true)
 const after=await qa26DemoAccountView(id,'h5c-managed-qa26',db,'2026-12-19T00:00:00Z')
 assert.equal(after.trial.canRestore,false)
 assert.equal(after.trial.daysRemaining,0)
})
test('billing admin shell requires login and redirects only to the matching QA tenant login',async()=>{
  const db=stub()
  const a=new Hono()
  registerQa26DemoControlPlaneRoutes(a,async()=>null,db)
  for(const slug of ['h5c-managed-qa26','h5c-custom-qa26']){
    const res=await a.request('/qa26/demo-portal',{headers:{host:slug+'-admin.hi5central.com'}})
    assert.equal(res.status,302)
    assert.equal(res.headers.get('location'),'https://'+slug+'.hi5central.com/billing-sign-in')
    assert.equal(res.headers.get('location').includes('returnTo='),false)
  }
  assert.equal((await a.request('/qa26/demo-portal',{headers:{host:'unrelated-tenant-admin.hi5central.com'}})).status,404)
  assert.equal((await a.request('/qa26/demo-portal',{headers:{host:'h5c-managed-qa26-admin.hi5central.com',origin:'https://h5c-custom-qa26.hi5central.com'}})).status,302)
})
test('authenticated MFA admin sees only its own responsive billing shell; cross-tenant cookie forbidden',async()=>{
  const db=stub()
  const a=app(db)
  const host='h5c-managed-qa26-admin.hi5central.com'
  const res=await a.request('/qa26/demo-portal',{headers:{host}})
  assert.equal(res.status,200)
  const html=await res.text()
  for(const needle of ['class="app-shell"','id="billingSidebar"','id="billingMenuToggle"',
    'Invoices & payments','Subscription & modules','Security & access',
    'billing-sign-in','QA DEMO'])assert.equal(html.includes(needle),true,needle)
  const bad=app(db,()=>session('h5c-custom-qa26'))
  assert.equal((await bad.request('/qa26/demo-portal',{headers:{host}})).status,403)
  const noMfa=app(db,()=>session('h5c-managed-qa26','owner',false))
  assert.equal((await noMfa.request('/qa26/demo-portal',{headers:{host}})).status,302)
  assert.equal(db.state.size,0)
})

test('reminder previews never deliver external email or call Stripe',async()=>{
 const db=stub(),a=app(db)
 const r=await a.request('/api/v1/qa26/demo-account/reminder',post('',{kind:'day14_checkin'}).init)
 assert.equal(r.status,200)
 const body=await r.json()
 assert.equal(body.emailActuallySent,false)
 assert.equal(body.previewOnly,true)
 assert.equal(db.sql.some(q=>/stripe|sendmail|smtp/i.test(q)),false)
})
