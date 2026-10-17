import test from 'node:test'
import assert from 'node:assert/strict'
import {operatorMaintenanceWindowAllowed} from '../src/releaseOperatorMaintenanceWindow.js'
import {nextTenantMaintenanceWindow,activeTenantMaintenanceWindow} from '../src/releaseRolloutPlanner.js'

const zone='Europe/London'
test('Saturday and Sunday explicitly selected are allowed in QA overnight 02:00–05:00',()=>{
 const all=['mon','tue','wed','thu','fri','sat','sun']
 const policy={timezone:zone,days:all,start:'02:00',end:'05:00'}
 // British Summer Time: Saturday 17 Oct and Sunday 18 Oct 2026.
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-17T01:30:00Z')),true)
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-18T01:30:00Z')),true)
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-17T20:15:00Z')),false)
 const next=nextTenantMaintenanceWindow({policy,now:'2026-10-17T20:15:00Z',
  durationMinutes:15})
 assert.equal(next.ok,true)
 assert.equal(next.scheduledAt,'2026-10-18T01:00:00.000Z')
 assert.equal(activeTenantMaintenanceWindow({policy,
  now:'2026-10-18T01:00:00Z',durationMinutes:20}).allowed,true)
})
test('Saturday-only overnight window extends into Sunday morning, never into Monday',()=>{
 const policy={timezone:zone,days:['sat'],start:'22:00',end:'03:00'}
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-17T21:30:00Z')),true)
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-18T00:30:00Z')),true)
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-18T21:30:00Z')),false)
 assert.equal(operatorMaintenanceWindowAllowed({...policy,days:['sun']},
  new Date('2026-10-18T00:30:00Z')),false)
})
test('Sunday-only overnight extends into Monday before closing',()=>{
 const policy={timezone:zone,days:['sun'],start:'22:00',end:'03:00'}
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-18T21:30:00Z')),true)
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-19T00:30:00Z')),true)
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-19T21:30:00Z')),false)
})
test('missing days, time zone, invalid times and non-weekend choices fail closed',()=>{
 assert.equal(operatorMaintenanceWindowAllowed({timezone:zone,days:[],
  start:'02:00',end:'05:00'},new Date('2026-10-18T01:30:00Z')),false)
 assert.equal(operatorMaintenanceWindowAllowed({days:['sun'],
  start:'02:00',end:'05:00'},new Date('2026-10-18T01:30:00Z')),false)
 assert.equal(operatorMaintenanceWindowAllowed({timezone:zone,days:['mon','tue','wed','thu','fri'],
  start:'02:00',end:'05:00'},new Date('2026-10-18T01:30:00Z')),false)
 assert.equal(operatorMaintenanceWindowAllowed({timezone:zone,days:['sun'],
  start:'invalid',end:'05:00'},new Date('2026-10-18T01:30:00Z')),false)
})
test('UK autumn DST repeated hour may be scheduled safely on Sunday',()=>{
 const policy={timezone:zone,days:['sun'],start:'01:30',end:'03:30'}
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-25T00:45:00Z')),true)
 assert.equal(operatorMaintenanceWindowAllowed(policy,new Date('2026-10-25T01:45:00Z')),true)
 const next=nextTenantMaintenanceWindow({policy,now:'2026-10-24T21:00:00Z',
  durationMinutes:15})
 assert.equal(next.ok,true)
 assert.equal(next.scheduledAt,'2026-10-25T00:30:00.000Z')
})
