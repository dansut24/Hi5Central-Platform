import assert from 'node:assert/strict'
import { changesSince, releaseCatalog } from '../src/applicationUpdates.js'

const shaA='a'.repeat(40),shaB='b'.repeat(40),shaC='c'.repeat(40)
const catalog=releaseCatalog({sha:shaA,version:'test',releaseName:'2026.10.11+'+shaA.slice(0,8),commits:[
  {sha:shaA,subject:'feat: tracked changes',kind:'feature',files:['apps/itsm/src/test.jsx'],migrations:[]},
  {sha:shaB,subject:'fix: original release',kind:'fix',files:['services/api/src/test.js'],migrations:[]},
  {sha:shaC,subject:'chore: older',kind:'maintenance',files:[],migrations:['services/api/migrations/platform-admin/145.sql']},
]})
assert.equal(catalog.releaseName,'2026.10.11+aaaaaaaa')
assert.equal(catalog.changes.length,3)
assert.equal(changesSince(catalog,shaA).changes.length,0)
assert.deepEqual(changesSince(catalog,shaB).changes.map(x=>x.sha),[shaA])
assert.equal(changesSince(catalog,shaC).changes.length,2)
assert.equal(changesSince(catalog,'').knownBaseline,false)
assert.equal(changesSince(catalog,'d'.repeat(40)).knownBaseline,false)
assert.equal(catalog.changes[2].migrations.length,1)
console.log('PASS: version catalog, tracked schema, and UAT-to-Production diff selection')
