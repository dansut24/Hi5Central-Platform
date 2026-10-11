import assert from 'node:assert/strict'
import { validateReleaseNotes, validateCustomerVersion, customerVersionLabel } from '../src/applicationUpdates.js'

const sha='c'.repeat(40)
const submitted={buildSha:sha,versionLabel:'2026.10.2',
  title:'October platform updates',summary:'Improvements to ITSM and RMM',
  entries:[{category:'feature',title:'Improved Live Chat panel',description:'Messaging while working on incidents.'},
    {category:'fix',title:'Better UAT release layout',description:'Drawer stays below UAT banner.'}]}
const valid=validateReleaseNotes(submitted)
assert.equal(valid.buildSha,sha)
assert.equal(valid.entries.length,2)
assert.equal(valid.versionLabel,'2026.10.2')
assert.deepEqual(valid.entries.map(item=>item.category),['feature','fix'])
assert.throws(()=>validateReleaseNotes({...submitted,buildSha:'latest'}),/valid build/)
assert.throws(()=>validateReleaseNotes({...submitted,title:' '}),/release title/)
assert.throws(()=>validateReleaseNotes({...submitted,entries:[]}),/between 1/)
assert.throws(()=>validateReleaseNotes({...submitted,entries:[{category:'secret',title:'Internal'}]}),/category/)
assert.throws(()=>validateReleaseNotes({...submitted,entries:[{category:'feature',title:'x'}]}),/descriptive title/)
const veryLong='x'.repeat(1500)
assert.equal(validateReleaseNotes({...submitted,summary:veryLong}).summary.length,1200)
assert.equal(validateReleaseNotes({...submitted,entries:[{category:'security',title:'Security improvements',description:veryLong}]}).entries[0].description.length,950)
assert.equal(customerVersionLabel('2026.10.11+2199e58a'),'2026.10.11')
assert.equal(customerVersionLabel('v1.2.3+deadbeef'),'v1.2.3')
assert.equal(customerVersionLabel('v2.0.0-beta.1'),'v2.0.0-beta.1')
assert.equal(validateCustomerVersion('1.0.1'),'1.0.1')
assert.equal(validateCustomerVersion('2026.10.1'),'2026.10.1')
assert.equal(validateCustomerVersion('v2.0.0-rc.1'),'v2.0.0-rc.1')
assert.throws(()=>validateCustomerVersion('2026.10.11+2199e58a'),/Build IDs/)
assert.throws(()=>validateCustomerVersion('Version Two'),/customer version/)
assert.throws(()=>validateReleaseNotes({...submitted,versionLabel:'2026.10.11+2199e58a'}),/Build IDs/)
console.log('PASS: curated customer notes require immutable build/version and valid publishable entries')
