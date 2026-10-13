import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db.js'
import { recordVerifiedSandboxStripeEvent } from '../src/stripeBillingWebhooks.js'

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
    await pool.end()
  }
})
