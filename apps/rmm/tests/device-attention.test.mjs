import test from 'node:test'
import assert from 'node:assert/strict'
import { deviceAttentionItems } from '../src/lib/deviceAttention.js'

test('healthy online devices generate no device-health observations', () => {
  assert.deepEqual(deviceAttentionItems([{ id: 'ok', name: 'Healthy', status: 'Online', health: 'Healthy' }]), [])
})
test('offline and critical devices show real state, not policy events', () => {
  const items = deviceAttentionItems([
    { id: 'laptop', name: 'Lenovo', status: 'Offline', health: 'Healthy' },
    { id: 'server', name: 'DB', status: 'Online', health: 'Critical' },
    { id: 'warn', name: 'Dell', status: 'Online', health: 'Warning' },
  ])
  assert.deepEqual(items.map(i => [i.deviceId, i.severity]), [
    ['server','Critical'], ['laptop','High'], ['warn','Medium']
  ])
  assert.ok(items.every(item => item.source === 'device-health' && item.detail.includes('not an evaluated monitoring-policy alert')))
})
test('empty, malformed and unrelated inventory does not invent alerts', () => {
  assert.deepEqual(deviceAttentionItems(undefined), [])
  assert.deepEqual(deviceAttentionItems({}), [])
  assert.deepEqual(deviceAttentionItems([null, {}, { name: 'missing id', health: 'Critical' }, { id: 'unknown', health: 'Unknown' }]), [])
})
test('one item per device and stable identifier', () => {
  const items = deviceAttentionItems([{ id: 'abc', name: 'Endpoint', status: 'Offline', health: 'Critical' }])
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'device-health:abc')
  assert.equal(items[0].severity, 'Critical')
})
