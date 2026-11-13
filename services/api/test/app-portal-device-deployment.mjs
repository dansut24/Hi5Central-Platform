import test from 'node:test'
import assert from 'node:assert/strict'
import { selfServicePowerShell, SELF_SERVICE_PORTAL_SHA256,
  SELF_SERVICE_PATCHHOST_SHA256, classifySelfServiceDeployment } from '../src/appPortalDeviceDeployment.js'

test('Self Service deploys only pinned Hi5Central binaries using Agent, not browser code', () => {
  const cmd = selfServicePowerShell(true)
  assert.ok(cmd.startsWith("$ErrorActionPreference='Stop'"))
  assert.ok(cmd.includes('Hi5CentralSelfServiceOnBoot'))
  assert.ok(cmd.includes('Hi5CentralSelfServiceHourly'))
  assert.ok(cmd.includes('FromBase64String'))
  const match = cmd.match(/FromBase64String\('([^']+)'\)/)
  assert.ok(match)
  const script = Buffer.from(match[1], 'base64').toString('utf8')
  assert.ok(script.includes(SELF_SERVICE_PORTAL_SHA256))
  assert.ok(script.includes(SELF_SERVICE_PATCHHOST_SHA256))
  assert.ok(script.includes('Get-FileHash'))
  assert.ok(script.includes("Get-Process -Name $processName"))
  assert.ok(script.includes('Hi5Central Self Service.lnk'))
  assert.ok(!script.includes('Stop-Service'))
  assert.ok(!script.includes('Remove-Service'))
})
test('Disabling retains installed app and removes reconcile schedules',()=>{
  const cmd = selfServicePowerShell(false)
  assert.ok(cmd.includes('Unregister-ScheduledTask'))
  assert.ok(cmd.includes("applicationRetained=$true"))
  assert.ok(!cmd.includes('Remove-Item -LiteralPath $portalDest'))
})
test('Status never claims installed before a completed Agent job',()=>{
  assert.equal(classifySelfServiceDeployment(null),'not_enabled')
  assert.equal(classifySelfServiceDeployment({enabled:true}),'waiting_for_device')
  assert.equal(classifySelfServiceDeployment({enabled:true,job_status:'queued'}),'queued')
  assert.equal(classifySelfServiceDeployment({enabled:true,job_status:'claimed'}),'installing')
  assert.equal(classifySelfServiceDeployment({enabled:true,job_status:'failed'}),'failed')
  assert.equal(classifySelfServiceDeployment({enabled:true,job_status:'completed'}),'installed')
})
test('Invalid policy inputs cannot build a deployment command',()=>{
  assert.throws(()=>selfServicePowerShell('yes'))
  assert.throws(()=>selfServicePowerShell(undefined))
})

import { isUuid } from '../src/appPortalDeviceRoutes.js'

test('Device policy IDs must be complete valid tenant-scoped UUIDs', () => {
  assert.equal(isUuid('12345678-1234-4123-8123-123456789abc'),true)
  assert.equal(isUuid('12345678-1234-4123-8123-123456789ab'),false)
  assert.equal(isUuid('untrusted'),false)
})
