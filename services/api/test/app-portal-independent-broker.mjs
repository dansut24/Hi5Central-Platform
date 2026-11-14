import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const api=readFileSync(new URL('../src/rmmAppPortal.js',import.meta.url),'utf8')
const patch=readFileSync(new URL('../src/rmmPatching.js',import.meta.url),'utf8')
test('independent broker authenticates existing machine secret and claims only App Portal patch jobs',()=>{
  const claim=api.slice(api.indexOf("app.post('/api/v1/agent/app-portal/broker/jobs/claim'"),api.indexOf("app.post('/api/v1/agent/app-portal/broker/heartbeat'"))
  assert.match(claim,/await requireAgent\(c\)/)
  assert.match(claim,/status='queued'/)
  assert.match(claim,/job_type='patch.software'/)
  assert.match(claim,/request_metadata->>'source'='app_portal'/)
  assert.match(claim,/FOR UPDATE SKIP LOCKED LIMIT 1/)
  assert.doesNotMatch(claim,/custom.command|agent_upgrade|remote.session/)
})
test('independent Broker install still validates tenant device policy and published assignment',()=>{
  const install=api.slice(api.indexOf("app.post('/api/v1/agent/app-portal/install'"),api.indexOf("app.get('/api/v1/rmm/app-portal/installations"))
  assert.match(install,/await requireAgent\(c\)/)
  assert.match(install,/rmm_device_self_service/)
  assert.match(install,/resolvedApps\(auth.agent, identity\)/)
  assert.match(install,/assignment = available.find/)
  assert.match(install,/independentBroker/)
})
test('catalogue offline bypass is internal flag only and retains host checks',()=>{
  const plan=patch.slice(patch.indexOf('export async function softwarePatchPlan('))
  assert.match(plan,/options.independentBroker/)
  assert.match(plan,/capabilities.softwareInstall !== true/)
})
