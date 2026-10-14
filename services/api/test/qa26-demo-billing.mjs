import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  qa26DemoInvoiceView,registerQa26DemoTenantRoutes,registerQa26DemoAdminRoutes,
} from '../src/qa26DemoBilling.js'

const managedId='11111111-1111-4111-8111-111111111111'
const customId='22222222-2222-4222-8222-222222222222'
const tenants=new Map([[managedId,'h5c-managed-qa26'],[customId,'h5c-custom-qa26']])

function fakeDb() {
  const states=new Map()
  const queries=[]
  return {
    queries,states,
    async query(sql,args=[]) {
      queries.push(sql)
      if (sql.startsWith('SELECT id,slug FROM tenants')) {
        const slug=tenants.get(args[0])
        return {rowCount:slug?1:0,rows:slug?[{id:args[0],slug}]:[]}
      }
      if (sql.includes('SELECT invoice_key,status,attempts,paid_at,updated_at')) {
        const rows=[...states.values()].filter(item=>item.tenantId===args[0])
        return {rowCount:rows.length,rows:rows.map(item=>({
          invoice_key:item.key,status:item.status,attempts:item.attempts,paid_at:item.paidAt,
        }))}
      }
      if (sql.startsWith('INSERT INTO qa26_demo_invoice_states')) {
        const [tenantId,key,status]=args
        const id=tenantId+':'+key
        const prior=states.get(id)
        if (prior?.status==='paid'||prior?.attempts>=25) return {rowCount:0,rows:[]}
        const next={tenantId,key,status,attempts:(prior?.attempts||0)+1,paidAt:status==='paid'?new Date().toISOString():null}
        states.set(id,next)
        return {rowCount:1,rows:[next]}
      }
      if (sql.includes('SELECT status,attempts FROM qa26_demo_invoice_states')) {
        const item=states.get(args[0]+':'+args[1])
        return {rowCount:item?1:0,rows:item?[item]:[]}
      }
      throw new Error('UNEXPECTED_SQL: '+sql.slice(0,90))
    },
  }
}
function session(slug='h5c-managed-qa26',role='owner',mfa=true) {
  const tenantId=slug==='h5c-custom-qa26'?customId:managedId
  return {slug,tenant_id:tenantId,user_id:'33333333-3333-4333-8333-333333333333',
    tenant_role:role,mfa_verified_at:mfa?new Date():null,authentication_type:'session'}
}
function appFor(db,getSession=async()=>session()) {
  const app=new Hono()
  registerQa26DemoTenantRoutes(app,getSession,db)
  return app
}
const jsonPost=(origin,outcome)=>({method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({outcome})})

test('managed and custom example quantities are isolated and all response values explicitly fake',async()=>{
  const db=fakeDb()
  const managed=await qa26DemoInvoiceView(managedId,'h5c-managed-qa26',db)
  const custom=await qa26DemoInvoiceView(customId,'h5c-custom-qa26',db)
  assert.equal(managed.demo,true)
  assert.equal(managed.realPayments,false)
  assert.equal(managed.stripeConnected,false)
  assert.equal(managed.totals.openPence,19500)
  assert.equal(custom.totals.openPence,300500)
  assert.equal(custom.invoices.length,3)
  assert.equal(managed.invoices.length,2)
  assert.equal(await qa26DemoInvoiceView(managedId,'real-customer',db),null)
  assert.equal(await qa26DemoInvoiceView('invalid','h5c-managed-qa26',db),null)
  assert.equal(db.queries.length,2)
})
test('no login, non-owner, no MFA, API token and other tenant cannot access demo ledger',async()=>{
  const db=fakeDb()
  for (const [s,expected] of [[null,401],[session('ordinary-tenant'),404],
    [session('h5c-managed-qa26','technician'),403],
    [session('h5c-managed-qa26','owner',false),403],
    [{...session(),authentication_type:'api_token'},403]]) {
    const app=appFor(db,async()=>s)
    assert.equal((await app.request('/api/v1/qa26/demo-billing')).status,expected)
  }
  assert.equal((await appFor(db).request('/api/v1/qa26/demo-billing', {headers:{origin:'https://h5c-custom-qa26.hi5central.com'}})).status,403)
  assert.equal((await appFor(db).request('/api/v1/qa26/demo-billing', {headers:{referer:'https://h5c-custom-qa26.hi5central.com/settings/subscription'}})).status,403)
  assert.equal(db.queries.length,0)
})
test('fake payment declines, retries, succeeds and becomes idempotently paid only for the signed-in tenant',async()=>{
  const db=fakeDb()
  let selected=session()
  const app=appFor(db,async()=>selected)
  const path='/api/v1/qa26/demo-billing/oct-rmm-itsm/simulate'
  const origin='https://h5c-managed-qa26.hi5central.com'
  assert.equal((await app.request(path,jsonPost('https://h5c-custom-qa26.hi5central.com','succeeded'))).status,403)
  assert.equal((await app.request(path,jsonPost(origin,'invalid'))).status,400)
  assert.equal((await app.request(path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403)
  const declined=await app.request(path,jsonPost(origin,'declined'))
  assert.equal(declined.status,200)
  assert.equal((await declined.json()).status,'payment_failed')
  assert.equal((await qa26DemoInvoiceView(managedId,selected.slug,db)).totals.openPence,19500)
  const successful=await app.request(path,jsonPost(origin,'succeeded'))
  assert.equal(successful.status,200)
  const paid=await successful.json()
  assert.equal(paid.realChargeCreated,false)
  assert.equal(paid.stripeCalled,false)
  assert.equal(paid.status,'paid')
  const again=await (await app.request(path,jsonPost(origin,'succeeded'))).json()
  assert.equal(again.alreadyPaid,true)
  const managed=await qa26DemoInvoiceView(managedId,selected.slug,db)
  assert.equal(managed.totals.openPence,0)
  assert.equal(managed.invoices[0].attempts,2)
  selected=session('h5c-custom-qa26')
  const custom=await (await app.request('/api/v1/qa26/demo-billing')).json()
  assert.equal(custom.totals.openPence,300500)
  assert.equal((await app.request(path,jsonPost(origin,'succeeded'))).status,403)
  assert(db.queries.every(q=>q.includes('qa26_demo_invoice_states')))
})
test('platform billing roles can view only two QA26 demo tenants and cannot use this endpoint to pay',async()=>{
  const db=fakeDb()
  let role='billing'
  const app=new Hono()
  registerQa26DemoAdminRoutes(app,async(c,roles)=>
    roles.has(role)?{session:{role}}:{error:c.json({error:'Forbidden'},403)},db)
  const get=id=>app.request('/api/platform/v1/billing/qa26/tenants/'+id+'/demo')
  assert.equal((await get(managedId)).status,200)
  assert.equal((await get(customId)).status,200)
  assert.equal((await get('bad-id')).status,400)
  assert.equal((await get('44444444-4444-4444-8444-444444444444')).status,404)
  role='read_only'
  assert.equal((await get(managedId)).status,403)
  assert.equal((await app.request('/api/platform/v1/billing/qa26/tenants/'+managedId+'/demo',{method:'POST'})).status,404)
})
