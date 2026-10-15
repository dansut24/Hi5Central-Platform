import assert from 'node:assert/strict'
import test from 'node:test'
import {auditSettingName,auditValueText,describeAuditValueChange} from './itsmAuditDescriptions.js'

test('Milestones disabled: readable description and On to Off',()=>{
 const result=describeAuditValueChange({
  path:'projects.showMilestones',kind:'boolean',
  before:true,after:false,beforeSource:'saved',
 })
 assert.equal(result.text,'Show milestones was turned off')
 assert.equal(result.before,'On')
 assert.equal(result.after,'Off')
})
test('Default on state is clearly identified',()=>{
 const result=describeAuditValueChange({
  path:'projects.showMilestones',kind:'boolean',
  before:true,after:false,beforeSource:'default',
 })
 assert.equal(result.source,'Previous value was the built-in default.')
})
test('SLA values use a compact previous and new change description',()=>{
 const result=describeAuditValueChange({
  path:'slaTargets.High.responseMinutes',kind:'number',
  before:'30',after:'45',beforeSource:'saved',
 })
 assert.equal(result.before,'30')
 assert.equal(result.after,'45')
 assert.match(result.text,/changed from 30 to 45/)
})
test('No historical previous values are fabricated',()=>{
 const result=describeAuditValueChange({
  path:'catalogue.enabled',kind:'boolean',
  before:null,after:false,beforeSource:'unknown',
 })
 assert.equal(result.before,'Not previously recorded')
 assert.equal(auditValueText(undefined),'Not previously recorded')
 assert.equal(auditSettingName('projects.showMilestones'),'Show milestones')
})
