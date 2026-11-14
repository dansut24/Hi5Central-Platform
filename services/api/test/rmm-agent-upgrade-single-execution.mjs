import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const file = new URL('../src/rmmAgent.js', import.meta.url)
const source = readFileSync(file,'utf8')
const upgradeSection = source.slice(source.indexOf('function agentUpgradeScript('),source.indexOf('export function portableAgentUpgradeScript('))
test('Windows Agent installer handoff schedules exactly once without immediate duplicate launch',()=>{
  assert.match(upgradeSection,/New-ScheduledTaskTrigger -Once -At .*AddSeconds\(35\)/)
  assert.match(upgradeSection,/Register-ScheduledTask -TaskName/)
  assert.doesNotMatch(upgradeSection,/^\s*"Start-ScheduledTask -TaskName/m)
})
test('installer upgrade is hash-verified before scheduling',()=>{
  assert.match(upgradeSection,/Get-FileHash -Algorithm SHA256/)
  assert.match(upgradeSection,/SHA-256 mismatch/)
})
