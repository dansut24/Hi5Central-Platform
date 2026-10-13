import {test} from 'node:test'
import assert from 'node:assert/strict'
import {billableDeviceCount,estimateDeviceCharge,BILLING_IDLE_DAYS} from '../src/platformTenantOverview.js'

const now='2026-10-13T12:00:00.000Z'
const daysAgo=d=>new Date(new Date(now).getTime()-d*86400000).toISOString()
test('RMM counts authenticated or checked-in agents only within inclusive 30-day window',()=>{
  const devices=[
    {id:1,last_telemetry_at:daysAgo(5),disabled_at:null},
    {id:2,last_authenticated_at:daysAgo(30),disabled_at:null},
    {id:3,last_authenticated_at:daysAgo(31),disabled_at:null},
    {id:4,websocket_connected_at:daysAgo(20),disabled_at:null},
    {id:5,last_telemetry_at:daysAgo(2),disabled_at:daysAgo(1)},
    {id:6,last_telemetry_at:null,last_authenticated_at:null,disabled_at:null},
    {id:7,last_telemetry_at:'nonsense',last_authenticated_at:daysAgo(7),disabled_at:null},
  ]
  assert.equal(BILLING_IDLE_DAYS,30)
  assert.equal(billableDeviceCount(devices,new Date(now)),4)
})
test('month-old disabled or missing check-ins are excluded, never charged',()=>{
  assert.equal(billableDeviceCount([
    {last_telemetry_at:daysAgo(31),disabled_at:null},
    {last_authenticated_at:daysAgo(100),disabled_at:null},
    {disabled_at:daysAgo(3),last_authenticated_at:daysAgo(1)},
    {disabled_at:null},
  ],new Date(now)),0)
})
test('device billing remains an estimate, never a fabricated invoice',()=>{
  const a=estimateDeviceCharge({rmmEnabled:true,basePence:1000,perDevicePence:250,billableCount:3})
  assert.equal(a.estimatedMonthlyPence,1750)
  assert.equal(a.billableDevices,3)
  assert.equal(a.estimatedOnly,true)
  assert.equal(a.excludesTax,true)
  const missing=estimateDeviceCharge({rmmEnabled:true,basePence:1000,perDevicePence:null,billableCount:3})
  assert.equal(missing.estimatedMonthlyPence,null)
  assert.equal(estimateDeviceCharge({rmmEnabled:false,basePence:1000,perDevicePence:null,billableCount:99}).estimatedMonthlyPence,1000)
  assert.throws(()=>estimateDeviceCharge({rmmEnabled:true,basePence:1000,perDevicePence:-1,billableCount:3}))
})
