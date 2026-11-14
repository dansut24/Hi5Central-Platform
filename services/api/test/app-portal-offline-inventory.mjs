import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const portal = readFileSync(new URL('../src/rmmAppPortal.js', import.meta.url), 'utf8')
const device = readFileSync(new URL('../src/appPortalDeviceRoutes.js', import.meta.url), 'utf8')
test('native installed inventory comes only from the authenticated Agent tenant and inventory', () => {
  const block = portal.slice(portal.indexOf("app.post('/api/v1/agent/app-portal/catalogue'"),
    portal.indexOf("app.post('/api/v1/agent/app-portal/install'"))
  assert.match(block, /await requireAgent\(c\)/)
  assert.match(block, /installedSoftware: installedSoftware\.rows/)
  assert.match(block, /WHERE tenant_id=\$1 AND inventory_id=\$2/)
  assert.match(block, /auth\.agent\.tenant_id, auth\.agent\.inventory_id/)
})
test('technician installed/available software is tenant-scoped and read-only', () => {
  const block = device.slice(device.indexOf("app.get('/api/v1/rmm/app-portal/devices/:agentDeviceId/software'"),
    device.indexOf("app.post('/api/v1/rmm/app-portal/devices/:agentDeviceId/self-service'"))
  assert.match(block, /const ctx = await context\(c\)/)
  assert.match(block, /ctx\.auth\.session\.tenant_id,ctx\.device\.inventory_id/)
  assert.match(block, /installedSoftware:programs\.rows/)
  assert.match(block, /resolveAppsForDevice/)
  assert.doesNotMatch(block, /INSERT|DELETE|UPDATE rmm_agent_jobs/)
})
test('latest signed-in user resolver reads end-user identity only from same tenant/device', () => {
  const match = portal.match(/async resolveAppsForDevice\(device\) \{([\s\S]*?)\n    \},/)
  assert.ok(match)
  assert.match(match[1], /WHERE tenant_id=\$1 AND agent_device_id=\$2/)
  assert.match(match[1], /resolvedApps\(device, identity\)/)
})
