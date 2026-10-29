import assert from 'node:assert/strict'
import test from 'node:test'
import { describeInventoryAge } from '../src/lib/inventoryFreshness.js'

const now = Date.parse('2026-10-29T10:00:00.000Z')
test('current inventory is distinguished from Agent online state', () => {
  assert.deepEqual(describeInventoryAge('2026-10-29T09:59:55Z', now), {
    label: 'Just now', ageMs: 5000, older: false, reported: true,
  })
  assert.equal(describeInventoryAge('2026-10-29T09:56:00Z', now).label, '4m ago')
})
test('an older snapshot is informational, not falsely marked as offline', () => {
  assert.equal(describeInventoryAge('2026-10-29T09:49:00Z', now).older, true)
  assert.equal(describeInventoryAge('2026-10-29T08:25:00Z', now).label, '1h 35m ago')
})
test('bad or absent collection dates do not invent freshness', () => {
  assert.equal(describeInventoryAge(null, now).reported, false)
  assert.equal(describeInventoryAge('not-a-date', now).reported, false)
})
test('clock skew never renders a negative age', () => {
  assert.equal(describeInventoryAge('2026-10-29T10:03:00Z', now).label, 'Just now')
})
