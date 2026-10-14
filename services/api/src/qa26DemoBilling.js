import { pool } from './db.js'
import { deployment, originMatchesTenant } from './deploymentConfig.js'

// Deliberately NO Stripe SDK, Stripe keys, Checkout URLs, or commercial-setting writes.
// This self-contained experience is an explicitly fake QA26-only prototype.
const CATALOG = Object.freeze({
  'h5c-managed-qa26': [
    { key:'oct-rmm-itsm',number:'DEMO-MANAGED-2026-10',issuedOn:'2026-10-01',dueOn:'2026-10-31',items:[{title:'ITSM technicians (5 demo seats)',quantity:5,unitPence:2900},{title:'RMM endpoints (20 illustrative devices)',quantity:20,unitPence:250}] },
    { key:'sep-rmm-itsm',number:'DEMO-MANAGED-2026-09',issuedOn:'2026-09-01',dueOn:'2026-09-30',originallyPaid:true,items:[{title:'ITSM technicians (5 demo seats)',quantity:5,unitPence:2900},{title:'RMM endpoints (20 illustrative devices)',quantity:20,unitPence:250}] },
  ],
  'h5c-custom-qa26': [
    { key:'oct-rmm',number:'DEMO-CUSTOM-2026-10',issuedOn:'2026-10-01',dueOn:'2026-10-31',items:[{title:'RMM endpoints (50 illustrative devices)',quantity:50,unitPence:250}] },
    { key:'oct-itsm',number:'DEMO-CUSTOM-2026-YEAR',issuedOn:'2026-10-01',dueOn:'2026-10-31',items:[{title:'ITSM annual technicians (10 demo seats)',quantity:10,unitPence:28800}] },
    { key:'sep-rmm',number:'DEMO-CUSTOM-2026-09',issuedOn:'2026-09-01',dueOn:'2026-09-30',originallyPaid:true,items:[{title:'RMM endpoints (50 illustrative devices)',quantity:50,unitPence:250}] },
  ],
})
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function enabled() {
  // Never enable on the self-hosted edition; the allowlist makes accidental
  // exposure to a real paying customer impossible.
  return deployment.deploymentMode === 'managed'
    && process.env.QA26_DEMO_BILLING_DISABLED !== 'true'
}
function isQa(slug) { return Object.hasOwn(CATALOG, slug) }
function invoiceAmount(invoice) {
  return invoice.items.reduce((sum,item)=>sum+item.quantity*item.unitPence,0)
}
export async function qa26DemoInvoiceView(tenantId, slug, db = pool) {
  if (!enabled() || !isQa(slug) || !UUID.test(tenantId)) return null
  const states = await db.query(
    'SELECT invoice_key,status,attempts,paid_at,updated_at FROM qa26_demo_invoice_states WHERE tenant_id=$1',
    [tenantId],
  )
  const byKey = new Map(states.rows.map(row => [row.invoice_key,row]))
  const invoices = CATALOG[slug].map(item => {
    const state = byKey.get(item.key)
    const status = state?.status || (item.originallyPaid ? 'paid' : 'open')
    return {
      number:item.number,key:item.key,issuedOn:item.issuedOn,dueOn:item.dueOn,
      currency:'GBP',status,amountPence:invoiceAmount(item),
      amountRemainingPence:status==='paid'?0:invoiceAmount(item),
      items:item.items,attempts:state?.attempts || 0,
      paidAt:state?.paid_at || (item.originallyPaid ? item.dueOn : null),
    }
  })
  return {
    demo:true,realPayments:false,stripeConnected:false,canPayRealInvoice:false,
    mode:'QA26_FAKE_BILLING',tenant:{id:tenantId,slug},invoices,
    totals:{
      openPence:invoices.reduce((total,row)=>total+row.amountRemainingPence,0),
      paidPence:invoices.filter(row=>row.status==='paid').reduce((total,row)=>total+row.amountPence,0),
    },
    notice:'SIMULATED QA DATA. No cards, Stripe API, tax calculation, real invoices, actual RMM usage, or commercial subscription changes.',
  }
}

export function registerQa26DemoTenantRoutes(app, resolveSession, db = pool) {
  async function owner(c) {
    const session = await resolveSession(c)
    if (!session) return { error:c.json({error:'Authentication required.'},401) }
    if (!enabled() || !isQa(session.slug)) return { error:c.json({error:'Not found.'},404) }
    if (!['owner','admin'].includes(session.tenant_role) || !session.mfa_verified_at || session.authentication_type==='api_token') {
      return { error:c.json({error:'Verified tenant owner or administrator session required.'},403) }
    }
    return {session}
  }
  app.get('/api/v1/qa26/demo-billing',async c=>{
    const auth = await owner(c)
    if (auth.error) return auth.error
    return c.json(await qa26DemoInvoiceView(auth.session.tenant_id,auth.session.slug,db))
  })
  app.post('/api/v1/qa26/demo-billing/:key/simulate',async c=>{
    const auth = await owner(c)
    if (auth.error) return auth.error
    const origin = c.req.header('origin')
    if (!origin || !originMatchesTenant(origin,auth.session.slug)) {
      return c.json({error:'Tenant-origin verification required.'},403)
    }
    if (!String(c.req.header('content-type')||'').toLowerCase().startsWith('application/json')) {
      return c.json({error:'JSON required.'},415)
    }
    const invoice = CATALOG[auth.session.slug].find(row=>row.key===c.req.param('key'))
    if (!invoice) return c.json({error:'Demo invoice not found.'},404)
    if (invoice.originallyPaid) return c.json({error:'This example invoice is already paid.'},409)
    const payload = await c.req.json().catch(()=>null)
    if (!payload || !['succeeded','declined'].includes(payload.outcome)) {
      return c.json({error:'Select succeeded or declined simulation.'},400)
    }
    const desired = payload.outcome==='succeeded'?'paid':'payment_failed'
    const update = await db.query(
      "INSERT INTO qa26_demo_invoice_states (tenant_id,invoice_key,status,attempts,paid_at,updated_by) VALUES ($1,$2,$3,1,CASE WHEN $3='paid' THEN now() ELSE NULL END,$4) ON CONFLICT (tenant_id,invoice_key) DO UPDATE SET status=EXCLUDED.status,attempts=qa26_demo_invoice_states.attempts+1,paid_at=EXCLUDED.paid_at,updated_at=now(),updated_by=EXCLUDED.updated_by WHERE qa26_demo_invoice_states.status<>'paid' AND qa26_demo_invoice_states.attempts<25 RETURNING status,attempts",
      [auth.session.tenant_id,invoice.key,desired,auth.session.user_id],
    )
    if (!update.rowCount) {
      const status = await db.query(
        'SELECT status,attempts FROM qa26_demo_invoice_states WHERE tenant_id=$1 AND invoice_key=$2',
        [auth.session.tenant_id,invoice.key],
      )
      if (status.rows[0]?.status==='paid') return c.json({demo:true,alreadyPaid:true,status:'paid'})
      return c.json({error:'Demo attempt limit reached.'},429)
    }
    return c.json({demo:true,realChargeCreated:false,stripeCalled:false,
      status:update.rows[0].status,attempts:update.rows[0].attempts})
  })
}

export function registerQa26DemoAdminRoutes(app,requireAdmin,db = pool) {
  app.get('/api/platform/v1/billing/qa26/tenants/:id/demo',async c=>{
    const auth = await requireAdmin(c,new Set(['owner','admin','billing']))
    if (auth.error) return auth.error
    const tenantId=String(c.req.param('id')||'')
    if (!UUID.test(tenantId)) return c.json({error:'Invalid tenant ID.'},400)
    const tenant = await db.query('SELECT id,slug FROM tenants WHERE id=$1',[tenantId])
    if (!tenant.rowCount || !enabled() || !isQa(tenant.rows[0].slug)) {
      return c.json({error:'QA demo tenant not found.'},404)
    }
    return c.json(await qa26DemoInvoiceView(tenantId,tenant.rows[0].slug,db))
  })
}
