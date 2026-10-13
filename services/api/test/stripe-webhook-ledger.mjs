import { createHash, createHmac } from 'node:crypto'
import { Hono } from 'hono'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db.js'
import { recordVerifiedSandboxStripeEvent, registerStripeBillingWebhookRoutes } from '../src/stripeBillingWebhooks.js'

test('verified sandbox event persists once, duplicate is ignored, ID collision rejected', async () => {
  const fixture = {
    id: 'evt_CiSandboxIdempotency1', created:1791925090, livemode:false,
    type:'invoice.paid',
    data:{object:{
      id:'in_CiSandboxExample123', customer:'cus_CiSandboxExample123',
      amount_paid:4900, currency:'gbp',
    }},
  }
  const sha = createHash('sha256').update(JSON.stringify(fixture)).digest('hex')
  try {
    const first = await recordVerifiedSandboxStripeEvent(fixture, sha)
    assert.deepEqual(first, {duplicate:false,resolution:'unmapped'})
    const second = await recordVerifiedSandboxStripeEvent(fixture, sha)
    assert.deepEqual(second, {duplicate:true,resolution:'unmapped'})
    await assert.rejects(() => recordVerifiedSandboxStripeEvent(fixture,'0'.repeat(64)), /stripe_event_id_collision/)
    const rows = await pool.query('SELECT * FROM stripe_sandbox_webhook_events WHERE stripe_event_id=$1',[fixture.id])
    assert.equal(rows.rowCount,1)
    assert.equal(rows.rows[0].tenant_id,null)
    assert.equal(rows.rows[0].amount_paid_pence,'4900')
    assert.equal(rows.rows[0].currency,'gbp')
    assert.equal(rows.rows[0].resolution,'unmapped')
  } finally {
    await pool.query('DELETE FROM stripe_sandbox_webhook_events WHERE stripe_event_id=$1',[fixture.id])
  }
})

// Integration test uses a synthetic signing secret and isolated CI PostgreSQL.
// It proves HTTP auth, transaction commit, duplicate acknowledgements and no tenant assignment.
test('HTTP Stripe webhook accepts authentic sandbox event exactly once', async () => {
  const event = {
    id:'evt_CiSignedHttpSandbox2026',created:Math.floor(Date.now()/1000),livemode:false,
    type:'invoice.paid',data:{object:{
      id:'in_CiSandboxInvoice2026',customer:'cus_CiSandboxCustomer2026',
      amount_paid:2000,currency:'gbp',
    }},
  }
  const secret='whsec_CiSyntheticWebhookSecret'
  const raw=JSON.stringify(event)
  const signature=createHmac('sha256',secret)
    .update(String(event.created)).update('.').update(raw).digest('hex')
  const header='t='+event.created+',v1='+signature
  const vars={
    STRIPE_BILLING_MODE:'sandbox',
    STRIPE_SECRET_KEY:'sk_test_CiDummyKey',
    STRIPE_EXPECTED_ACCOUNT_ID:'acct_CiSyntheticAccount2026',
    STRIPE_WEBHOOK_ENABLED:'true',
    STRIPE_WEBHOOK_SECRET:secret,
  }
  const previous=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]))
  Object.assign(process.env,vars)
  const app=new Hono()
  registerStripeBillingWebhookRoutes(app)
  try {
    const request=async (payload=raw,sig=header)=>app.request('/api/platform/v1/billing/stripe/webhook',{
      method:'POST',headers:{'content-type':'application/json','stripe-signature':sig},body:payload,
    })
    const unsigned=await request(raw,'')
    assert.equal(unsigned.status,400)
    const good=await request()
    assert.equal(good.status,200)
    assert.deepEqual(await good.json(),{received:true,duplicate:false})
    const retry=await request()
    assert.equal(retry.status,200)
    assert.deepEqual(await retry.json(),{received:true,duplicate:true})
    const rows=await pool.query('SELECT resolution,tenant_id,amount_paid_pence FROM stripe_sandbox_webhook_events WHERE stripe_event_id=$1',[event.id])
    assert.equal(rows.rowCount,1)
    assert.equal(rows.rows[0].resolution,'unmapped')
    assert.equal(rows.rows[0].tenant_id,null)
    assert.equal(rows.rows[0].amount_paid_pence,'2000')
  } finally {
    await pool.query('DELETE FROM stripe_sandbox_webhook_events WHERE stripe_event_id=$1',[event.id])
    for (const [key,value] of Object.entries(previous)) {
      if(value === undefined) delete process.env[key]
      else process.env[key]=value
    }
  }
})

test.after(async () => { await pool.end() })

